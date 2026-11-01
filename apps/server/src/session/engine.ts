import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import type { Sql } from '../db/db.js';
import { ASSETS, CORE_TICKERS, SECTORS } from '../market/assets.js';
import { QUIET_REPORT, quietReports, schedule, type Context } from '../market/events.js';
import { noteId, noteStory } from '../market/notes.js';
import { seedReports, summarize, type Report, type Summary } from '../market/fundamentals.js';
import { initialState, MarketSim, type SimEvent, type SimNote } from '../market/sim.js';
import { metrics } from '../metrics.js';
import { reactionBps, reactionMembers } from '../market/dashboard.js';
import type {
  Activity, Reaction, AssetInfo, BoardRow, BookInfo, ClientMsg, EventInfo, FullBoard, HoldingResult, PlayerResult, PortfolioView, Regime, Results, RoomInfo,
  RoomListing, ServerMsg, SessionInfo,
} from '../protocol.js';
import { apply, pnlByTicker, quote, returnBps, STARTING_CASH, valueOf, type Book } from '../trading/portfolio.js';
import { compareRank, phaseAt, sharpe, type Phase } from './ranking.js';
import * as store from './store.js';

export interface EngineConfig {
  lobbySeconds: number;
  tradingSeconds: number;
  closingSeconds: number;
  resultsSeconds: number;
  tickMs: number;
  maxPlayers: number;
  /** Most custom rooms live at once, across every host. */
  maxRooms: number;
  /** Fixed seed for each competition's news (reproducible demos); unset = random per competition. */
  seed?: number;
  /** Seed for the market's first-ever state. Only used once, when no checkpoint exists. */
  marketSeed?: number;
}

/** The client key for the house competition; a custom room's clients are keyed by its session id. */
export const HOUSE = '';

export interface Client {
  userId: string;
  nickname: string;
  /** HOUSE, or the session id of the room this socket joined. */
  room: string;
  send(data: string): void;
}

interface Player {
  id: string;
  userId: string;
  nickname: string;
  joinedAt: number;
  book: Book;
  trades: number;
  /** Serialises this player's orders: one at a time, in arrival order. */
  chain: Promise<unknown>;
  /** Portfolio value every SAMPLE_EVERY ticks, for the risk-adjusted award. */
  samples: number[];
  /** Value gained across major event windows, for the event award. */
  eventGain: number;
}

/** Prices around one story: the tick before it landed, and the end of its reaction window once reached. */
interface Tape {
  seq: number;
  endSeq: number;
  before: number[];
  after: number[] | null;
}

interface Window {
  endSeq: number;
  start: Map<string, number>;
}

export interface Live {
  row: store.SessionRow;
  cfg: store.SessionConfig;
  /** The companies this competition lists, in market order. */
  listed: Set<string>;
  /** Where this competition's sockets are filed: HOUSE or the session id. */
  key: string;
  opensAt: number;
  closesAt: number;
  /** Market seq at the opening bell; null while the competition is still a lobby. */
  startSeq: number | null;
  /** Prices at the opening bell (the market's current prices while in the lobby). */
  open: number[];
  /**
   * Every price at the competition's last tick, captured on that tick. The market carries on for other
   * rooms, so everything after the bell (orders, ranking, results) is valued at these and nothing later.
   */
  frozen: number[] | null;
  players: Map<string, Player>;
  phase: Phase;
  windows: Window[];
  finishing: boolean;
  finishedAt: number | null;
  results: { top: PlayerResult[]; awards: Results['awards']; all: Map<string, PlayerResult> } | null;
  hostName: string | null;
  lastBoard: number;
  boardCache: FullBoard | null;
}

const eur = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const SAMPLE_EVERY = 10;
/** Market ticks between checkpoints. A crash loses nothing: the ticks since are replayed identically. */
const CHECKPOINT_EVERY = 10;
const SNAPSHOT_EVERY = 30;
const BOARD_MS = 2000;
const BOARD_SIZE = 10;
const NEWS_KEPT = 40;
/** A manual room nobody starts is closed after this long. */
const LOBBY_EXPIRY_MS = 24 * 3600 * 1000;
/** Live rooms one host may run at once. */
const ROOMS_PER_HOST = 3;
/** Room codes skip 0, 1, I and O so they survive being read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Initial market seed when none is configured: the first market is the same on every install. */
const GENESIS_SEED = 0x4a6716;
const LOCK_KEY = 4373;
/** How long after a story its reaction is measured. */
const REACTION_MS = 60_000;

const TICKERS = ASSETS.map((a) => a.ticker);
const TICKER_INDEX = new Map(ASSETS.map((a, i) => [a.ticker, i]));
const risk = (vol: number): AssetInfo['risk'] => (vol < 0.0026 ? 'low' : vol < 0.004 ? 'medium' : 'high');

const toSim = (ev: store.StoredEvent): SimEvent => ({
  id: ev.id, seq: ev.seq, duration: ev.duration, jump: ev.jump, persistence: ev.persistence, severity: ev.severity, effects: ev.effects,
});

const eventInfo = (ev: store.StoredEvent): EventInfo => ({
  id: ev.id, sessionId: ev.sessionId, seq: ev.seq, at: ev.publishedAt ?? 0, category: ev.category, scope: ev.scope, target: ev.target,
  related: ev.related, headline: ev.headline, body: ev.body, figures: ev.figures, severity: ev.severity,
});

const bookInfo = (p: Player): BookInfo => ({
  participantId: p.id,
  cash: p.book.cash,
  positions: [...p.book.positions].filter(([, x]) => x.qty > 0 || x.realized !== 0).map(([ticker, x]) => ({ ticker, ...x })),
  trades: p.trades,
});

const holdingsOf = (book: Book, priceOf: (t: string) => number): HoldingResult[] =>
  [...book.positions]
    .filter(([, x]) => x.qty > 0 || x.realized !== 0)
    .map(([ticker, x]) => ({ ticker, qty: x.qty, cost: x.cost, realized: x.realized, close: priceOf(ticker) }))
    .sort((a, b) => b.qty * b.close - a.qty * a.close || b.realized - a.realized);

export interface RoomInput {
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  maxPlayers: number;
  startingCash: number;
  durationSeconds: number;
  /** Epoch ms of a scheduled bell; null = the host starts it. */
  startAt: number | null;
  lateJoin: boolean;
  peek: boolean;
  reveal: boolean;
  publicResults: boolean;
  /** The companies the room lists. */
  tickers: string[];
}

type Buffer = Omit<store.Checkpoint, 'prevSeq' | 'state'>;
const emptyBuffer = (): Buffer => ({ prices: [], published: [], cancelled: [], reports: [], notes: [] });

export class Engine {
  /** Every competition still in memory: the house one and each custom room, keyed by session id. */
  readonly rooms = new Map<string, Live>();
  house: Live | null = null;
  market!: MarketSim;
  /** Set when another process turned out to own the market: this one stops advancing it. */
  fenced = false;
  /**
   * The market's clock while it runs: tick `seq` played at `at`, one tick per tickMs since. Set when the
   * first competition opens on an idle market; every room that opens while it runs is aligned to it.
   */
  private anchor: { seq: number; at: number } | null = null;
  private readonly clients = new Map<string, Map<string, Set<Client>>>();
  private readonly joining = new Map<string, Promise<Player | null>>();
  private readonly reports = new Map<string, Report[]>();
  private summaries: Summary[] = [];
  private readonly events = new Map<number, store.StoredEvent>();
  private news: EventInfo[] = [];
  private readonly tapes = new Map<number, Tape>();
  private readonly activityCache = new Map<string, { until: number; body: Activity }>();
  private regime: Regime = 'calm';
  private lastAt = Date.now();
  private savedSeq = 0;
  private buffer = emptyBuffer();
  private failed: store.Checkpoint | null = null;
  private saving: Promise<boolean> = Promise.resolve(true);
  private marketJson: string | null = null;
  private lock: Awaited<ReturnType<Sql['reserve']>> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private retryAt = 0;

  constructor(
    private readonly sql: Sql,
    private readonly cfg: EngineConfig,
    private readonly log: Logger,
  ) {}

  async start() {
    // One writer per market. A second process on the same database refuses to start rather than
    // advancing its own copy of the prices.
    this.lock = await this.sql.reserve();
    const [locked] = await this.lock<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`;
    if (!locked?.ok) {
      this.lock.release();
      this.lock = null;
      throw new Error('another Haggle process owns this market');
    }
    try {
      await this.boot();
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.timer = setInterval(() => void this.pump(), 100);
  }

  private async boot() {
    await store.upsertAssets(this.sql, ASSETS);
    let stored = await store.loadReports(this.sql);
    const have = new Set(stored.map((r) => r.ticker));
    const missing = ASSETS.filter((a) => !have.has(a.ticker));
    if (missing.length) {
      await store.insertReports(this.sql, missing.flatMap(seedReports));
      stored = await store.loadReports(this.sql);
    }
    for (const r of stored) {
      if (!this.reports.has(r.ticker)) this.reports.set(r.ticker, []);
      this.reports.get(r.ticker)!.push(r);
    }
    this.summaries = ASSETS.map((a) => summarize(a, this.reports.get(a.ticker) ?? []));
    const fairs = this.summaries.map((s, i) => s.fair?.cents ?? ASSETS[i]!.base);

    let state = await store.latestCheckpoint(this.sql);
    if (!state) {
      // The first market ever: seeded once, from the last pre-persistence closing prices when there are any.
      await store.initMarket(this.sql, initialState(ASSETS, this.cfg.marketSeed ?? GENESIS_SEED, fairs, await store.legacyClosingPrices(this.sql)));
      state = (await store.latestCheckpoint(this.sql))!;
      this.log.info({ seq: state.seq }, 'market initialised');
    }
    this.market = new MarketSim(ASSETS, state, fairs);
    this.savedSeq = state.seq;
    // Fair values move only when a report lands, inside the tape: re-applying them here would make a
    // restarted market diverge from one that never stopped.
    this.regime = this.market.regime();
    for (const ev of await store.liveEvents(this.sql, state.seq, ASSETS)) this.track(ev);
    this.news = await store.recentNews(this.sql, NEWS_KEPT);
    await this.loadTapes();

    for (const row of await store.liveSessions(this.sql)) await this.resume(row);
    this.catchUp();
    if (!this.house) await this.newSession();
  }

  /** Stops the clock, waits for the last checkpoint and releases the market. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.saving;
    if (this.lock) {
      await this.lock`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
      this.lock.release();
      this.lock = null;
    }
  }

  private track(ev: store.StoredEvent) {
    this.events.set(ev.id, ev);
    this.market.load([toSim(ev)]);
  }

  // ---------------------------------------------------------------- clock

  private localTick(live: Live) {
    if (live.startSeq === null) return 0;
    return live.frozen ? live.cfg.totalTicks : this.market.seq - live.startSeq;
  }

  /** Competitions whose ticks are still being played. The market runs while there is one. */
  private running(): Live[] {
    return [...this.rooms.values()].filter((l) => l.startSeq !== null && !l.frozen && l.finishedAt === null);
  }

  private atOf(seq: number) {
    const a = this.anchor!;
    return a.at + (seq - a.seq) * this.cfg.tickMs;
  }

  /** The tick the clock says the market should be on: never past the last tick any running room needs. */
  private target(now: number, running: Live[]) {
    const a = this.anchor!;
    const due = a.seq + Math.floor((now - a.at) / this.cfg.tickMs);
    return Math.min(due, Math.max(...running.map((l) => l.startSeq! + l.cfg.totalTicks)));
  }

  /** Restart recovery: replays the ticks the clock says should have happened while the server was away. */
  private catchUp() {
    const running = this.running();
    if (!running.length) return;
    // Every room that opened during one run of the market is on the same tick grid.
    const first = running.sort((a, b) => a.startSeq! - b.startSeq!)[0]!;
    this.anchor = { seq: first.startSeq!, at: first.opensAt };
    const target = this.target(Date.now(), running);
    while (this.market.seq < target) this.stepOnce(false);
  }

  private async pump() {
    if (this.busy || this.fenced) return;
    this.busy = true;
    try {
      let now = Date.now();
      for (const live of [...this.rooms.values()]) {
        if (live.startSeq !== null || live.finishedAt !== null || now < live.opensAt) continue;
        if (live.cfg.manualStart) {
          await this.abandon(live);
        } else if (live.players.size === 0) {
          // An empty room keeps waiting rather than running a market nobody trades: an always-on box
          // would otherwise move the shared market for no one.
          live.opensAt = now + this.cfg.lobbySeconds * 1000;
          live.closesAt = live.opensAt + live.cfg.totalTicks * this.cfg.tickMs;
          await store.setSessionTimes(this.sql, live.row.id, new Date(live.opensAt), new Date(live.closesAt));
          this.broadcastPhase(live);
        } else if (now >= this.retryAt) {
          await this.open(live);
        }
      }

      now = Date.now();
      const running = this.running();
      if (running.length && now >= this.retryAt) {
        const target = this.target(now, running);
        metrics.tickLagMs = Math.max(0, now - this.atOf(this.market.seq) - this.cfg.tickMs);
        while (this.market.seq < target) this.stepOnce(true);
      }
      if (this.anchor && !this.running().length) this.idle();

      for (const live of [...this.rooms.values()]) {
        let phase = phaseAt(now, live.opensAt, live.closesAt, live.cfg.closingSeconds, live.finishedAt !== null);
        // The results wait for the competition's last tick, which may land a moment after the clock says so.
        if (phase === 'results' && live.finishedAt === null && live.startSeq !== null && !live.frozen) phase = 'closing';
        if (phase !== live.phase) {
          live.phase = phase;
          this.broadcastPhase(live);
        }
        if (phase === 'results' && live.finishedAt === null && now >= this.retryAt) await this.finish(live);
        if (live.finishedAt !== null && now >= live.finishedAt + live.cfg.resultsSeconds * 1000) {
          if (live === this.house) await this.newSession();
          else this.rooms.delete(live.row.id);
          continue;
        }
        if (phase !== 'results' && now - live.lastBoard >= BOARD_MS) {
          live.lastBoard = now;
          this.broadcastBoard(live);
        }
      }
      metrics.players = [...this.rooms.values()].reduce((n, l) => n + l.players.size, 0);
    } catch (err) {
      metrics.dbErrors++;
      this.retryAt = Date.now() + 2000;
      this.log.error({ err }, 'session pump failed');
    } finally {
      this.busy = false;
    }
  }

  /**
   * The opening bell. The competition's news is decided from its seed and stored, unpublished, in the
   * same transaction that opens it; the market starts from wherever it stands. A room that opens while
   * the market is already running joins its tick grid, so every room shares one tape.
   */
  private async open(live: Live) {
    const tickMs = this.cfg.tickMs;
    const opensAt = this.anchor ? this.atOf(this.market.seq) : live.opensAt;
    // shortcut: rooms that overlap each add their own schedule to the one shared tape, so the news is
    // denser while several rooms trade at once; share one market-level schedule if that gets noisy.
    const ctx: Context = {
      assets: ASSETS,
      reports: (i) => this.reports.get(ASSETS[i]!.ticker) ?? [],
      ticksPerSecond: 1000 / tickMs,
      maxTick: live.cfg.totalTicks,
      at: (tick) => opensAt + tick * tickMs,
      value: (i) => this.market.value(i),
      listed: new Set(ASSETS.flatMap((a, i) => (live.listed.has(a.ticker) ? [i] : []))),
    };
    const stories = schedule(Number(live.row.seed), ctx, live.cfg.totalTicks);
    // Every other company files its quarter quietly during the competition.
    const storied = new Set(stories.flatMap((e) => (e.report ? [e.effects[0]!.asset] : [])));
    const quiet = quietReports(Number(live.row.seed), ctx, storied, live.cfg.totalTicks);
    const events = [...stories, ...quiet.map((e, k) => ({ ...e, ord: stories.length + k + 1 }))];
    const opening = Object.fromEntries(ASSETS.map((a, i) => [a.ticker, this.market.prices[i]!]));
    const closesAt = opensAt + live.cfg.totalTicks * tickMs;
    const opened = await store.openSession(this.sql, live.row.id, this.market.seq, opening, events, ASSETS, new Date(opensAt), new Date(closesAt));
    live.startSeq = opened.startSeq;
    live.opensAt = opensAt;
    live.closesAt = closesAt;
    live.row.status = 'trading';
    live.open = Array.from(this.market.prices);
    this.anchor ??= { seq: opened.startSeq, at: opensAt };
    for (const ev of opened.events) if (ev.status === 'scheduled') this.track(ev);
    this.log.info({ session: live.row.id, room: live.row.code, startSeq: live.startSeq, events: opened.events.length }, 'bell rung');
  }

  /** The last running competition has closed: the market stops, and stories still waiting never land. */
  private idle() {
    this.anchor = null;
    // The market stopping ends every reaction window still open.
    for (const t of this.tapes.values()) if (!t.after) [t.after, t.endSeq] = [Array.from(this.market.prices), this.market.seq];
    for (const ev of this.market.cancelPending()) {
      const stored = this.events.get(ev.id);
      if (stored) stored.status = 'cancelled';
      this.buffer.cancelled.push(ev.id);
    }
    for (const [id, ev] of this.events) if (ev.status !== 'scheduled') this.events.delete(id);
  }

  private stepOnce(broadcast: boolean) {
    const next = this.market.seq + 1;
    const running = this.running();
    let before: number[] | null = null;
    for (const ev of this.events.values()) {
      if (ev.seq !== next || ev.status !== 'scheduled') continue;
      before ??= Array.from(this.market.prices);
      if (ev.severity >= 2) for (const live of running) live.windows.push({ endSeq: ev.seq + ev.duration, start: this.values(live) });
    }

    const fired = this.market.step();
    const seq = this.market.seq;
    const at = this.atOf(seq);
    this.lastAt = at;
    const sessionId = running[0]?.row.id ?? null;
    ASSETS.forEach((a, i) => this.buffer.prices.push({ ticker: a.ticker, seq, at, sessionId, price: this.market.prices[i]! }));
    metrics.ticks++;
    if (broadcast) this.broadcastAll({ t: 'tick', k: seq, at, p: Array.from(this.market.prices) });

    if (running[0]) for (const note of this.market.notes) this.publishNote(note, at, running[0], broadcast);
    for (const sim of fired) {
      const ev = this.events.get(sim.id);
      if (!ev) continue;
      this.publish(ev, at, broadcast);
      // The window ends a minute on, or at the last tick of the competition that scheduled the story.
      const owner = this.rooms.get(ev.sessionId);
      const last = owner?.startSeq != null ? owner.startSeq + owner.cfg.totalTicks : Infinity;
      if (before) this.tapes.set(ev.id, { seq, endSeq: Math.min(seq + Math.round(REACTION_MS / this.cfg.tickMs), last), before, after: null });
    }
    for (const t of this.tapes.values()) if (!t.after && seq >= t.endSeq) t.after = Array.from(this.market.prices);
    if (fired.length) for (const id of this.tapes.keys()) if (!this.news.some((n) => n.id === id)) this.tapes.delete(id);
    const regime = this.market.regime();
    if (regime !== this.regime || this.market.notes.some((n) => n.kind.startsWith('credit'))) {
      this.regime = regime;
      if (broadcast) this.broadcastAll({ t: 'regime', regime, credit: this.market.credit });
    }

    let froze = false;
    for (const live of running) {
      const tick = seq - live.startSeq!;
      const end = tick >= live.cfg.totalTicks;
      const closing = live.windows.filter((w) => w.endSeq <= seq || end);
      if (closing.length) {
        const now = this.values(live);
        for (const w of closing) for (const [id, v0] of w.start) {
          const p = live.players.get(id);
          if (p) p.eventGain += (now.get(id) ?? v0) - v0;
        }
        live.windows = live.windows.filter((w) => !closing.includes(w));
      }
      if (tick % SAMPLE_EVERY === 0 || end) {
        for (const p of live.players.values()) p.samples.push(this.valueOf(live, p));
      }
      if (tick % SNAPSHOT_EVERY === 0) {
        this.background(store.recordSnapshot(this.sql, live.row.id, tick, this.ranking(live).slice(0, 50).map((r) => this.row(live, r))), 'snapshot');
      }
      if (end) {
        live.frozen = Array.from(this.market.prices);
        froze = true;
      }
    }
    if (seq % CHECKPOINT_EVERY === 0 || froze) void this.checkpoint();
  }

  /** A story lands: it goes out to everyone at once, and an earnings story files its report. */
  private publish(ev: store.StoredEvent, at: number, broadcast: boolean) {
    ev.status = 'published';
    ev.publishedAt = at;
    this.buffer.published.push({ id: ev.id, at });
    metrics.eventsPublished++;
    const quiet = ev.template === QUIET_REPORT;
    const info = eventInfo(ev);
    if (!quiet) this.news = [info, ...this.news.filter((n) => n.id !== ev.id)].slice(0, NEWS_KEPT);
    if (ev.report) {
      const i = TICKER_INDEX.get(ev.report.ticker);
      const list = this.reports.get(ev.report.ticker) ?? [];
      const dup = list.some((r) => r.fiscalYear === ev.report!.fiscalYear && r.fiscalQuarter === ev.report!.fiscalQuarter);
      if (i !== undefined && !dup) {
        list.push(ev.report);
        this.reports.set(ev.report.ticker, list);
        this.summaries[i] = summarize(ASSETS[i]!, list);
        const fair = this.summaries[i]!.fair;
        if (fair) this.market.setFair(i, fair.cents);
        this.buffer.reports.push({ report: ev.report, eventId: ev.id });
        this.marketJson = null;
        if (broadcast) this.broadcastAll({ t: 'fund', ticker: ev.report.ticker, fund: this.summaries[i]! });
      }
    }
    if (broadcast && !quiet) this.broadcastAll({ t: 'event', ev: info });
  }

  /**
   * Something the market itself did (a crash, a panic, the economy or credit turning) becomes news on
   * the tick it happened. Its id comes from the tick, so a replay after a restart stores and shows it once.
   */
  private publishNote(note: SimNote, at: number, live: Live, broadcast: boolean) {
    const id = noteId(note, note.sector ? SECTORS.indexOf(note.sector) : 0);
    if (this.news.some((n) => n.id === id)) return;
    const story = noteStory(note, this.market.credit);
    const info: EventInfo = { id, sessionId: live.row.id, seq: note.seq, at, ...story };
    this.buffer.notes.push({ ...story, id, sessionId: live.row.id, seq: note.seq, at, tick: this.localTick(live) });
    metrics.eventsPublished++;
    this.news = [info, ...this.news].slice(0, NEWS_KEPT);
    if (broadcast) this.broadcastAll({ t: 'event', ev: info });
  }

  /**
   * Makes everything since the last checkpoint durable in one transaction. Checkpoints run strictly
   * one after another; a failed one is folded into the next, so nothing is dropped while the
   * database is away. Resolves true once the market is durable up to now.
   */
  private checkpoint(): Promise<boolean> {
    const c: store.Checkpoint = { prevSeq: 0, state: this.market.state(), ...this.buffer };
    this.buffer = emptyBuffer();
    this.saving = this.saving.then(async () => {
      const f = this.failed;
      const job: store.Checkpoint = f
        ? {
          ...c, prices: [...f.prices, ...c.prices], published: [...f.published, ...c.published], cancelled: [...f.cancelled, ...c.cancelled],
          reports: [...f.reports, ...c.reports], notes: [...f.notes, ...c.notes],
        }
        : c;
      job.prevSeq = this.savedSeq;
      if (job.state.seq === this.savedSeq && !f && !c.prices.length && !c.cancelled.length && !c.notes.length) return true;
      try {
        await store.writeCheckpoint(this.sql, job);
        this.failed = null;
        this.savedSeq = job.state.seq;
        metrics.lastCheckpointAt = Date.now();
        metrics.checkpointLagTicks = this.market.seq - this.savedSeq;
        return true;
      } catch (err) {
        this.failed = job;
        metrics.checkpointFailures++;
        metrics.checkpointLagTicks = this.market.seq - this.savedSeq;
        if (err instanceof store.CheckpointConflict) {
          // Another writer moved the market on: stop rather than fork it.
          this.fenced = true;
          if (this.timer) clearInterval(this.timer);
          this.log.fatal({ err }, 'market checkpoint conflict, engine fenced');
        } else this.log.error({ err }, 'market checkpoint failed, will retry with the next one');
        return false;
      }
    });
    return this.saving;
  }

  private background(p: Promise<unknown>, what: string) {
    p.catch((err) => {
      metrics.dbErrors++;
      this.log.error({ err }, `${what} failed`);
    });
  }

  // ---------------------------------------------------------------- session lifecycle

  private build(row: store.SessionRow): Live {
    // An early close shortens the session; the stored close time is the authority on its length.
    const cfg = {
      ...row.config,
      startingCash: row.config.startingCash ?? STARTING_CASH,
      totalTicks: Math.min(row.config.totalTicks, Math.floor((row.closes_at.getTime() - row.opens_at.getTime()) / row.config.tickMs)),
    };
    return {
      row, cfg,
      listed: new Set(row.config.tickers ?? CORE_TICKERS),
      key: row.code ? row.id : HOUSE,
      opensAt: row.opens_at.getTime(),
      closesAt: row.closes_at.getTime(),
      startSeq: row.start_seq === null ? null : Number(row.start_seq),
      open: row.opening_prices ? ASSETS.map((a, i) => row.opening_prices![a.ticker] ?? this.market.prices[i]!) : Array.from(this.market.prices),
      frozen: null,
      players: new Map(),
      phase: 'lobby',
      windows: [],
      finishing: false,
      finishedAt: null,
      results: null,
      hostName: null,
      lastBoard: 0,
      boardCache: null,
    };
  }

  private async newSession() {
    const now = Date.now();
    const opensAt = new Date(now + this.cfg.lobbySeconds * 1000);
    const closesAt = new Date(opensAt.getTime() + this.cfg.tradingSeconds * 1000);
    const cfg: store.SessionConfig = {
      tickMs: this.cfg.tickMs,
      totalTicks: Math.floor((this.cfg.tradingSeconds * 1000) / this.cfg.tickMs),
      closingSeconds: this.cfg.closingSeconds,
      resultsSeconds: this.cfg.resultsSeconds,
      maxPlayers: this.cfg.maxPlayers,
      startingCash: STARTING_CASH,
    };
    const row = await store.createSession(this.sql, this.cfg.seed ?? randomInt(2 ** 31), opensAt, closesAt, cfg);
    if (this.house) this.rooms.delete(this.house.row.id);
    const live = this.build(row);
    this.house = live;
    this.rooms.set(row.id, live);
    this.log.info({ session: row.id, opensAt }, 'session created');
    // Everyone still connected from the last session is dealt into the new one.
    const here = this.clients.get(HOUSE) ?? new Map<string, Set<Client>>();
    await Promise.all(
      [...here.values()].map((set) => {
        const first = set.values().next().value;
        return first ? this.ensurePlayer(live, first.userId, first.nickname) : null;
      }),
    );
    for (const set of here.values()) for (const c of set) this.sendHello(c, live);
  }

  /** Restart recovery: books from the database; a room whose last tick already passed gets its close back. */
  private async resume(row: store.SessionRow) {
    const live = this.build(row);
    for (const p of await store.loadParticipants(this.sql, row.id)) {
      live.players.set(p.userId, {
        id: p.id, userId: p.userId, nickname: p.nickname, joinedAt: p.joinedAt.getTime(),
        book: { cash: p.cash, positions: p.positions }, trades: p.trades, chain: Promise.resolve(), samples: [], eventGain: 0,
      });
    }
    live.hostName = row.host_user_id ? (live.players.get(row.host_user_id)?.nickname ?? null) : null;
    // shortcut: value samples and event windows before the restart are lost, so the two secondary
    // awards only cover the time since; persist samples if restarts mid-session become routine.
    if (live.startSeq !== null && live.startSeq + live.cfg.totalTicks <= this.market.seq) {
      // The market moved on for other rooms after this one's last tick: its close is in the history.
      const close = await store.pricesAt(this.sql, live.startSeq + live.cfg.totalTicks);
      live.frozen = ASSETS.map((a, i) => close[a.ticker] ?? this.market.prices[i]!);
    }
    live.phase = phaseAt(Date.now(), live.opensAt, live.closesAt, live.cfg.closingSeconds, false);
    this.rooms.set(row.id, live);
    if (!row.code) this.house = live;
    this.log.info({ session: row.id, room: row.code, seq: this.market.seq, players: live.players.size }, 'session resumed');
  }

  private async finish(live: Live) {
    if (!live.finishing) {
      live.finishing = true;
      // A competition that never rang its bell under this engine has no ticks; it closes where the market is.
      live.frozen ??= Array.from(this.market.prices);
      // Orders that passed the phase check before the bell still settle; nothing new gets in.
      await Promise.allSettled([...live.players.values()].map((p) => p.chain));
    }
    // The closing prices are durable before anyone is ranked on them.
    if (!(await this.checkpoint())) throw new Error('closing checkpoint not durable yet');

    const ranking = this.ranking(live);
    const finishedAt = Date.now();
    const start = live.cfg.startingCash;
    const priceOf = this.pricer(live);
    const closing = Object.fromEntries(ASSETS.map((a) => [a.ticker, priceOf(a.ticker)]));

    const scored = ranking.map((r) => ({ ...r, sharpe: r.p.trades > 0 ? sharpe(r.p.samples) : null }));
    const awards: Results['awards'] = [];
    const award = (id: string, label: string, pick: (typeof scored)[number] | undefined, detail: string) => {
      if (pick) awards.push({ id, label, nickname: pick.p.nickname, detail });
    };
    const winner = scored[0];
    if (winner) award('winner', 'Top of the market', winner, `finished with ${eur(winner.value)}`);
    const steady = scored.filter((s) => s.sharpe !== null && s.value > start).sort((a, b) => b.sharpe! - a.sharpe!)[0];
    award('steady', 'Steadiest hand', steady, 'best risk-adjusted return');
    const eventer = scored.filter((s) => s.p.eventGain > 0).sort((a, b) => b.p.eventGain - a.p.eventGain || compareRank(a, b))[0];
    if (eventer) award('crier', 'Read the crier', eventer, `+${eur(eventer.p.eventGain)} during major events`);

    const all = new Map<string, PlayerResult>();
    for (const s of scored) {
      const pnl = pnlByTicker(s.p.book, priceOf).sort((a, b) => b.pnl - a.pnl);
      const best = pnl[0] && pnl[0].pnl > 0 ? pnl[0] : null;
      const worst = pnl.at(-1) && pnl.at(-1)!.pnl < 0 ? pnl.at(-1)! : null;
      all.set(s.p.userId, {
        participantId: s.p.id, nickname: s.p.nickname, rank: s.rank, of: scored.length, value: s.value, bps: returnBps(s.value, start), start,
        cash: s.p.book.cash, trades: s.p.trades, best, worst,
        holdings: holdingsOf(s.p.book, priceOf),
        awards: awards.filter((a) => a.nickname === s.p.nickname).map((a) => a.id),
        sessionId: live.row.id, finishedAt,
      });
    }

    await store.recordSnapshot(this.sql, live.row.id, this.localTick(live), ranking.map((r) => this.row(live, r)));
    await store.finishSession(this.sql, live.row.id, closing, [...all.values()], awards);
    live.results = { top: [...all.values()].slice(0, BOARD_SIZE), awards, all };
    live.finishedAt = finishedAt;
    live.phase = 'results';
    this.log.info({ session: live.row.id, room: live.row.code, players: all.size, winner: winner?.p.nickname }, 'session finished');
    this.broadcastPhase(live);
    for (const set of this.clients.get(live.key)?.values() ?? []) for (const c of set) this.send(c, { t: 'results', results: this.resultsFor(live, c.userId)! });
  }

  /** A manual room whose host never rang the bell: closed with no results. */
  private async abandon(live: Live) {
    await store.abandonSession(this.sql, live.row.id);
    live.finishedAt = Date.now();
    live.phase = 'results';
    live.results = { top: [], awards: [], all: new Map() };
    this.log.info({ session: live.row.id, room: live.row.code }, 'room abandoned before the bell');
    this.broadcastPhase(live);
    for (const set of this.clients.get(live.key)?.values() ?? []) for (const c of set) this.send(c, { t: 'results', results: this.resultsFor(live, c.userId)! });
  }

  /** Opens the bell now. Returns false when there is no lobby to open. */
  async openNow(live: Live | null = this.house): Promise<boolean> {
    if (!live || live.startSeq !== null || live.finishedAt !== null) return false;
    const now = Date.now();
    if (!live.cfg.manualStart && now >= live.opensAt) return false;
    const closesAt = now + live.cfg.totalTicks * this.cfg.tickMs;
    await store.startNow(this.sql, live.row.id, new Date(now), new Date(closesAt));
    live.opensAt = now;
    live.closesAt = closesAt;
    live.cfg.manualStart = false;
    this.log.info({ session: live.row.id, room: live.row.code }, 'bell opened early');
    return true;
  }

  /** Rings the final bell now, at the current prices. The next pump values every purse and publishes the results. */
  async closeNow(live: Live | null = this.house): Promise<boolean> {
    if (!live || live.startSeq === null || live.frozen || live.finishing) return false;
    // The tape never runs past the bell: the competition ends at the last tick already played.
    const tick = this.market.seq - live.startSeq;
    if (tick < 1) return false;
    live.cfg.totalTicks = tick;
    live.closesAt = live.opensAt + tick * this.cfg.tickMs;
    live.frozen = Array.from(this.market.prices);
    await store.setCloseTime(this.sql, live.row.id, new Date(live.closesAt));
    this.log.info({ session: live.row.id, room: live.row.code, tick }, 'market closed early');
    return true;
  }

  /** Skips the rest of the house results screen and opens the next lobby. */
  nextNow(): boolean {
    const live = this.house;
    if (!live || live.finishedAt === null) return false;
    live.finishedAt = Date.now() - live.cfg.resultsSeconds * 1000;
    return true;
  }

  /** What the host console shows: no player identity, just the room. */
  hostView() {
    const live = this.house;
    const b = live ? this.board(live) : null;
    return {
      serverNow: Date.now(),
      session: live ? this.sessionInfo(live) : null,
      board: { top: b?.top ?? [], count: b?.count ?? 0 },
      events: this.news.filter((e) => e.sessionId === live?.row.id).slice(0, 6),
      results: live?.results ? { top: live.results.top, awards: live.results.awards } : null,
    };
  }

  // ---------------------------------------------------------------- rooms

  /** Creates a custom room with the host already seated. Returns its code, or why it was refused. */
  async createRoom(host: { id: string; nickname: string }, input: RoomInput): Promise<{ code: string } | { error: string }> {
    const custom = [...this.rooms.values()].filter((l) => l.row.code && l.finishedAt === null);
    if (custom.length >= this.cfg.maxRooms) return { error: 'Too many rooms are running right now. Try again later.' };
    if (custom.filter((l) => l.row.host_user_id === host.id).length >= ROOMS_PER_HOST) return { error: `You can host ${ROOMS_PER_HOST} rooms at once.` };
    const now = Date.now();
    const opensAt = input.startAt ?? now + LOBBY_EXPIRY_MS;
    const totalTicks = Math.floor((input.durationSeconds * 1000) / this.cfg.tickMs);
    const cfg: store.SessionConfig = {
      tickMs: this.cfg.tickMs,
      totalTicks,
      closingSeconds: Math.min(this.cfg.closingSeconds, Math.floor(input.durationSeconds / 4)),
      resultsSeconds: this.cfg.resultsSeconds,
      maxPlayers: input.maxPlayers,
      startingCash: input.startingCash,
      manualStart: input.startAt === null,
      lateJoin: input.lateJoin,
      peek: input.peek,
      reveal: input.reveal,
      publicResults: input.publicResults,
      tickers: input.tickers,
    };
    let row: store.SessionRow | null = null;
    for (let attempt = 0; !row; attempt++) {
      const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      try {
        row = await store.createSession(this.sql, randomInt(2 ** 31), new Date(opensAt), new Date(opensAt + totalTicks * this.cfg.tickMs), cfg, {
          code, name: input.name, description: input.description, hostUserId: host.id, visibility: input.visibility,
        });
      } catch (err) {
        // 40 bits of code: a collision is a once-in-a-lifetime retry, anything else is a real failure.
        if ((err as { code?: string }).code !== '23505' || attempt >= 3) throw err;
      }
    }
    const live = this.build(row);
    live.hostName = host.nickname;
    this.rooms.set(row.id, live);
    await this.ensurePlayer(live, host.id, host.nickname);
    this.log.info({ session: row.id, room: row.code, host: host.id }, 'room created');
    return { code: row.code! };
  }

  liveByCode(code: string): Live | undefined {
    for (const l of this.rooms.values()) if (l.row.code === code) return l;
    return undefined;
  }

  /** The client key for a socket asking for a room code, live or finished; null when there is no such room. */
  async resolveRoom(code: string | null): Promise<string | null> {
    if (!code) return HOUSE;
    return this.liveByCode(code)?.row.id ?? (await store.sessionByCode(this.sql, code))?.id ?? null;
  }

  /** Public rooms anyone can join or watch, soonest first. */
  listRooms(): RoomListing[] {
    return [...this.rooms.values()]
      .filter((l) => l.row.code && l.row.visibility === 'public' && l.finishedAt === null)
      .map((l) => ({
        code: l.row.code!, name: l.row.name ?? 'Room', host: l.hostName, phase: l.phase, players: l.players.size, maxPlayers: l.cfg.maxPlayers,
        startingCash: l.cfg.startingCash, opensAt: l.opensAt, closesAt: l.closesAt, manualStart: !!l.cfg.manualStart, companies: l.listed.size,
      }))
      .sort((a, b) => a.opensAt - b.opensAt);
  }

  isHost(live: Live, userId: string) {
    return !!live.row.code && live.row.host_user_id === userId;
  }

  // ---------------------------------------------------------------- research data

  /** The listing with every company's fundamentals summary, serialised once per change. */
  marketJsonBody(): string {
    this.marketJson ??= JSON.stringify({
      assets: ASSETS.map((a, i) => ({
        ticker: a.ticker, name: a.name, exchange: a.exchange, sector: a.sector, industry: a.industry, description: a.description,
        beta: a.beta, risk: risk(a.vol), core: a.core, fund: this.summaries[i]!,
      })),
    });
    return this.marketJson;
  }

  /**
   * Prices around the stored news after a restart. Stories still inside their window when the process
   * stopped are measured again as the replayed ticks land; a window the market never reached stays open.
   */
  private async loadTapes() {
    const news = this.news.filter((n) => n.seq > 0);
    if (!news.length) return;
    const ends = await store.sessionEndSeqs(this.sql, [...new Set(news.map((n) => n.sessionId))]);
    const window = Math.round(REACTION_MS / this.cfg.tickMs);
    const spans = news.map((n) => ({ id: n.id, seq: n.seq, endSeq: Math.min(n.seq + window, ends.get(n.sessionId) ?? Infinity) }));
    const at = await store.pricesAtSeqs(this.sql, TICKERS, [...new Set(spans.flatMap((s) => [s.seq - 1, ...(Number.isFinite(s.endSeq) ? [s.endSeq] : [])]))]);
    const row = (m: Map<string, number> | undefined) => (m && m.size === TICKERS.length ? TICKERS.map((t) => m.get(t)!) : null);
    for (const s of spans) {
      const before = row(at.get(s.seq - 1));
      if (!before) continue;
      const reached = Number.isFinite(s.endSeq) && s.endSeq <= this.market.seq;
      this.tapes.set(s.id, { seq: s.seq, endSeq: s.endSeq, before, after: reached ? row(at.get(s.endSeq)) : null });
    }
  }

  /** The observed move after each recent story; stories without a recorded tape are left out. */
  reactions(live: Live | null = this.house): Reaction[] {
    const now = this.market.prices;
    const listed = ASSETS.filter((a) => (live?.listed ?? new Set(CORE_TICKERS)).has(a.ticker));
    return this.news.flatMap((ev) => {
      const tape = this.tapes.get(ev.id);
      if (!tape) return [];
      const { subject, tickers } = reactionMembers(ev, listed);
      const after = tape.after ?? now;
      const price = (row: ArrayLike<number>) => (t: string) => row[TICKER_INDEX.get(t)!];
      const r = reactionBps(tickers, price(tape.before), price(after));
      if (!r) return [];
      return [{
        id: ev.id, subject, bps: r.bps, ticks: (tape.after ? tape.endSeq : this.market.seq) - tape.seq + 1, settled: tape.after !== null,
        moves: subject === 'company' ? r.moves.slice(0, 6) : [],
      }];
    });
  }

  /** Trading activity per company in one competition, cached briefly: a whole room asks at once. */
  async activity(live: Live | null = this.house): Promise<Activity> {
    const id = live?.row.id ?? null;
    const hit = id ? this.activityCache.get(id) : undefined;
    if (hit && hit.until > Date.now()) return hit.body;
    const body: Activity = { sessionId: id, rows: id ? await store.tradeActivity(this.sql, id) : [] };
    if (id) {
      if (this.activityCache.size > 200) this.activityCache.clear();
      this.activityCache.set(id, { until: Date.now() + 5000, body });
    }
    return body;
  }

  companyReports(ticker: string): Report[] | null {
    return TICKER_INDEX.has(ticker) ? (this.reports.get(ticker) ?? []) : null;
  }

  roomOf(key: string): Live | null {
    return key === HOUSE ? this.house : (this.rooms.get(key) ?? null);
  }

  participantOf(userId: string, key = HOUSE): string | null {
    return this.roomOf(key)?.players.get(userId)?.id ?? null;
  }

  /** Every trader in a live competition, ranked at one valuation time; cached for a second. */
  fullBoard(live: Live): FullBoard {
    const now = Date.now();
    if (live.boardCache && now - live.boardCache.at < 1000 && !live.frozen) return live.boardCache;
    live.boardCache = { rows: this.ranking(live).map((r) => this.row(live, r)), at: live.frozen ? live.closesAt : this.lastAt };
    return live.boardCache;
  }

  /** One trader's book at the competition's current (or closing) prices. */
  portfolioOf(live: Live, participantId: string): PortfolioView | null {
    const p = [...live.players.values()].find((x) => x.id === participantId);
    if (!p) return null;
    return { participantId: p.id, nickname: p.nickname, cash: p.book.cash, holdings: holdingsOf(p.book, this.pricer(live)) };
  }

  // ---------------------------------------------------------------- players and orders

  private async ensurePlayer(live: Live, userId: string, nickname: string): Promise<Player | null> {
    if (live.finishing || live.finishedAt !== null || live.frozen) return null;
    const existing = live.players.get(userId);
    if (existing) return existing;
    if (live.startSeq !== null && live.cfg.lateJoin === false) return null;
    if (live.players.size >= live.cfg.maxPlayers) return null;
    // Two tabs connecting at once must not race the insert; the unique (session, user) row means a
    // repeated join never deals a second purse.
    const key = `${live.row.id}:${userId}`;
    const pending = this.joining.get(key);
    if (pending) return pending;
    const job = (async () => {
      const start = live.cfg.startingCash;
      const { id, joinedAt } = await store.joinSession(this.sql, live.row.id, userId, start);
      const p: Player = {
        id, userId, nickname, joinedAt: joinedAt.getTime(), book: { cash: start, positions: new Map() },
        trades: 0, chain: Promise.resolve(), samples: [], eventGain: 0,
      };
      if (this.localTick(live) > 0) p.samples.push(start);
      live.players.set(userId, p);
      return p;
    })().finally(() => this.joining.delete(key));
    this.joining.set(key, job);
    return job;
  }

  async attach(c: Client) {
    let room = this.clients.get(c.room);
    if (!room) this.clients.set(c.room, (room = new Map()));
    let set = room.get(c.userId);
    if (!set) room.set(c.userId, (set = new Set()));
    set.add(c);
    metrics.sockets++;
    const live = this.roomOf(c.room);
    if (live) {
      await this.ensurePlayer(live, c.userId, c.nickname);
      return this.sendHello(c, live);
    }
    // A room that finished and left memory: its results come from the database.
    const row = await store.sessionById(this.sql, c.room);
    if (!row) throw new Error('room vanished');
    const past = this.build(row);
    past.phase = 'results';
    past.finishedAt = row.finished_at?.getTime() ?? Date.now();
    past.frozen = past.open; // closed: only its tick count is read, and that is its full length
    const me = await store.resultForUser(this.sql, row.id, c.userId);
    past.results = { top: await store.sessionResults(this.sql, row.id, BOARD_SIZE), awards: row.awards ?? [], all: new Map(me ? [[c.userId, me]] : []) };
    this.sendHello(c, past);
  }

  detach(c: Client) {
    const room = this.clients.get(c.room);
    const set = room?.get(c.userId);
    if (set?.delete(c)) metrics.sockets--;
    if (set && set.size === 0) room!.delete(c.userId);
    if (room && room.size === 0 && c.room !== HOUSE) this.clients.delete(c.room);
  }

  order(c: Client, msg: ClientMsg): Promise<void> {
    const live = this.roomOf(c.room);
    const p = live?.players.get(c.userId);
    if (!live || !p) {
      this.send(c, { t: 'reject', id: msg.id, reason: 'not_in_session' });
      return Promise.resolve();
    }
    const job = p.chain.then(() => this.execute(live, p, msg));
    p.chain = job;
    return job;
  }

  /** Fills against the market's current price. Nothing here feeds back into the market: orders never move prices. */
  private async execute(live: Live, p: Player, msg: ClientMsg) {
    const started = performance.now();
    const reply = (m: ServerMsg) => this.sendUser(live, p.userId, m);
    const reject = (reason: Extract<ServerMsg, { t: 'reject' }>['reason']) => {
      metrics.orders.rejected++;
      reply({ t: 'reject', id: msg.id, reason });
    };

    const phase = phaseAt(Date.now(), live.opensAt, live.closesAt, live.cfg.closingSeconds, live.finishedAt !== null);
    if (live.finishing || live.frozen || live.startSeq === null || (phase !== 'trading' && phase !== 'closing') || !live.players.has(p.userId)) {
      return reject('market_closed');
    }
    const idx = TICKER_INDEX.get(msg.ticker);
    if (idx === undefined || !live.listed.has(msg.ticker)) return reject('unknown_asset');

    const fill = quote(p.book, msg.side, msg.ticker, msg.qty, this.market.prices[idx]!);
    if (!fill.ok) return reject(fill.reason);

    let tradeId: number;
    try {
      tradeId = await store.recordFill(this.sql, p.id, msg.id, fill, this.localTick(live));
    } catch (err) {
      if (err instanceof store.DuplicateOrder) {
        metrics.orders.duplicate++;
        return reply({ t: 'reject', id: msg.id, reason: 'duplicate' });
      }
      metrics.orders.failed++;
      this.log.error({ err, participant: p.id }, 'order failed');
      return reject('server_error');
    }
    apply(p.book, fill);
    p.trades++;
    live.boardCache = null;
    metrics.orders.filled++;
    metrics.orderLatencyMs.sum += performance.now() - started;
    metrics.orderLatencyMs.count++;
    reply({
      t: 'fill', id: msg.id, side: fill.side, ticker: fill.ticker, qty: fill.qty, price: fill.price, total: fill.total, realized: fill.realized, book: bookInfo(p),
      trade: { id: tradeId, at: Date.now(), ticker: fill.ticker, side: fill.side, qty: fill.qty, price: fill.price, total: fill.total, realized: fill.realized },
    });
  }

  // ---------------------------------------------------------------- views

  /** A competition's prices: its closing prices once its last tick has played, the live market until then. */
  private pricer(live: Live) {
    const prices = live.frozen ?? this.market.prices;
    return (t: string) => prices[TICKER_INDEX.get(t)!]!;
  }

  private valueOf(live: Live, p: Player) {
    return valueOf(p.book, this.pricer(live));
  }

  private values(live: Live): Map<string, number> {
    return new Map([...live.players.values()].map((p) => [p.userId, this.valueOf(live, p)]));
  }

  private ranking(live: Live) {
    return [...live.players.values()]
      .map((p) => ({ p, nickname: p.nickname, joinedAt: p.joinedAt, value: this.valueOf(live, p) }))
      .sort(compareRank)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  private row(live: Live, r: { rank: number; nickname: string; value: number; p: Player }): BoardRow {
    const priceOf = this.pricer(live);
    let top: string | null = null;
    let most = 0;
    for (const [ticker, pos] of r.p.book.positions) {
      const v = pos.qty * priceOf(ticker);
      if (v > most) [top, most] = [ticker, v];
    }
    return {
      rank: r.rank, participantId: r.p.id, nickname: r.nickname, value: r.value, cash: r.p.book.cash,
      bps: returnBps(r.value, live.cfg.startingCash), trades: r.p.trades, top,
    };
  }

  private roomInfo(live: Live): RoomInfo | null {
    const { row, cfg } = live;
    if (!row.code) return null;
    return {
      code: row.code, name: row.name ?? 'Room', description: row.description, visibility: row.visibility, hostId: row.host_user_id, host: live.hostName,
      settings: { manualStart: !!cfg.manualStart, lateJoin: cfg.lateJoin !== false, peek: !!cfg.peek, reveal: cfg.reveal !== false, publicResults: !!cfg.publicResults },
      companies: live.listed.size,
    };
  }

  sessionInfo(live: Live | null = this.house): SessionInfo | null {
    if (!live) return null;
    return {
      id: live.row.id,
      phase: live.phase,
      opensAt: live.opensAt,
      closingAt: live.closesAt - live.cfg.closingSeconds * 1000,
      closesAt: live.closesAt,
      nextAt: live.finishedAt === null || live !== this.house ? null : live.finishedAt + live.cfg.resultsSeconds * 1000,
      tick: this.localTick(live),
      totalTicks: live.cfg.totalTicks,
      tickMs: live.cfg.tickMs,
      players: live.players.size,
      maxPlayers: live.cfg.maxPlayers,
      startingCash: live.cfg.startingCash,
      room: this.roomInfo(live),
    };
  }

  private board(live: Live): { top: BoardRow[]; count: number; me: Map<string, BoardRow>; at: number } {
    const rows = this.ranking(live).map((r) => [r.p.userId, this.row(live, r)] as const);
    return { top: rows.slice(0, BOARD_SIZE).map(([, r]) => r), count: rows.length, me: new Map(rows), at: live.frozen ? live.closesAt : this.lastAt };
  }

  /**
   * The results a given player may see. A private room shows them only to its own traders unless the
   * host made them public; a room that keeps portfolios private shows each trader only their own.
   */
  private resultsFor(live: Live, userId: string): Results | null {
    const r = live.results;
    if (!r) return null;
    const me = r.all.get(userId) ?? null;
    const portfolios = live.cfg.reveal !== false;
    const restricted = !this.canView(live, userId);
    if (restricted) return { sessionId: live.row.id, top: [], awards: [], me: null, portfolios, restricted };
    const top = portfolios ? r.top : r.top.map((x) => (x.participantId === me?.participantId ? x : { ...x, holdings: undefined }));
    return { sessionId: live.row.id, top, awards: r.awards, me, portfolios, restricted };
  }

  /** Whether a user may see a competition's rankings and results: anyone for public rooms, else its own traders. */
  canView(live: Live, userId: string | null) {
    if (live.row.visibility === 'public' || live.cfg.publicResults) return true;
    return !!userId && (live.players.has(userId) || !!live.results?.all.has(userId));
  }

  private sendHello(c: Client, live: Live) {
    const p = live.players.get(c.userId);
    const b = this.board(live);
    this.send(c, {
      t: 'hello',
      serverNow: Date.now(),
      you: { userId: c.userId, nickname: c.nickname },
      session: this.sessionInfo(live),
      tickers: TICKERS,
      listed: TICKERS.filter((t) => live.listed.has(t)),
      sectors: [...new Set(ASSETS.filter((a) => live.listed.has(a.ticker)).map((a) => a.sector))],
      seq: this.market.seq,
      at: this.lastAt,
      prices: Array.from(this.market.prices),
      open: live.open,
      regime: this.regime,
      credit: this.market.credit,
      events: this.news,
      book: p ? bookInfo(p) : null,
      spectating: p
        ? null
        : live.finishedAt !== null || live.finishing || live.frozen
          ? 'closed'
          : live.startSeq !== null && live.cfg.lateJoin === false
            ? 'late'
            : 'full',
      board: this.canView(live, c.userId) ? { top: b.top, count: b.count, me: b.me.get(c.userId) ?? null, at: b.at } : { top: [], count: b.count, me: null, at: b.at },
      results: this.resultsFor(live, c.userId),
    });
  }

  // ---------------------------------------------------------------- transport

  private send(c: Client, msg: ServerMsg) {
    const data = JSON.stringify(msg);
    metrics.bytesOut += data.length;
    c.send(data);
  }

  /** To one player's sockets in one competition: a second tab in another room never sees this fill. */
  private sendUser(live: Live, userId: string, msg: ServerMsg) {
    for (const c of this.clients.get(live.key)?.get(userId) ?? []) this.send(c, msg);
  }

  /** Market-wide news and prices: every socket in every room. */
  private broadcastAll(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const room of this.clients.values()) for (const set of room.values()) for (const c of set) {
      metrics.bytesOut += data.length;
      c.send(data);
    }
  }

  private broadcastPhase(live: Live) {
    const data = JSON.stringify({ t: 'phase', serverNow: Date.now(), session: this.sessionInfo(live)!, open: live.open } satisfies ServerMsg);
    for (const set of this.clients.get(live.key)?.values() ?? []) for (const c of set) {
      metrics.bytesOut += data.length;
      c.send(data);
    }
  }

  private broadcastBoard(live: Live) {
    const b = this.board(live);
    // The shared part is serialised once; only the per-player tail differs.
    const head = `{"t":"board","board":{"top":${JSON.stringify(b.top)},"count":${b.count},"at":${b.at},"me":`;
    for (const [userId, set] of this.clients.get(live.key) ?? []) {
      if (!this.canView(live, userId)) continue;
      const data = `${head}${JSON.stringify(b.me.get(userId) ?? null)}}}`;
      for (const c of set) {
        metrics.bytesOut += data.length;
        c.send(data);
      }
    }
  }
}

