import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import type { Sql } from '../db/db.js';
import { ASSETS } from '../market/assets.js';
import { schedule } from '../market/events.js';
import { seedReports, summarize, type Report, type Summary } from '../market/fundamentals.js';
import { initialState, MarketSim, type SimEvent } from '../market/sim.js';
import { metrics } from '../metrics.js';
import { reactionBps, reactionMembers } from '../market/dashboard.js';
import type { Activity, AssetInfo, Board, BookInfo, ClientMsg, EventInfo, PlayerResult, Reaction, Regime, Results, ServerMsg, SessionInfo } from '../protocol.js';
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
  /** Fixed seed for each competition's news (reproducible demos); unset = random per competition. */
  seed?: number;
  /** Seed for the market's first-ever state. Only used once, when no checkpoint exists. */
  marketSeed?: number;
}

export interface Client {
  userId: string;
  nickname: string;
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

interface Live {
  row: store.SessionRow;
  cfg: store.SessionConfig;
  opensAt: number;
  closesAt: number;
  /** Market seq at the opening bell; null while the competition is still a lobby. */
  startSeq: number | null;
  /** Prices at the opening bell (the market's current prices while in the lobby). */
  open: number[];
  players: Map<string, Player>;
  phase: Phase;
  windows: Window[];
  finishing: boolean;
  finishedAt: number | null;
  results: { top: PlayerResult[]; awards: Results['awards']; all: Map<string, PlayerResult> } | null;
}

const eur = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const SAMPLE_EVERY = 10;
/** Ticks between checkpoints. A crash loses nothing: the ticks since are replayed identically. */
const CHECKPOINT_EVERY = 10;
const SNAPSHOT_EVERY = 30;
const BOARD_MS = 2000;
const BOARD_SIZE = 10;
const NEWS_KEPT = 40;
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

type Buffer = Omit<store.Checkpoint, 'prevSeq' | 'state'>;
const emptyBuffer = (): Buffer => ({ prices: [], published: [], cancelled: [], reports: [] });

export class Engine {
  live: Live | null = null;
  market!: MarketSim;
  /** Set when another process turned out to own the market: this one stops advancing it. */
  fenced = false;
  private readonly clients = new Map<string, Set<Client>>();
  private readonly joining = new Map<string, Promise<Player | null>>();
  private readonly reports = new Map<string, Report[]>();
  private summaries: Summary[] = [];
  private readonly events = new Map<number, store.StoredEvent>();
  private news: EventInfo[] = [];
  private readonly tapes = new Map<number, Tape>();
  private activityCache: { until: number; body: Activity } | null = null;
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
  private lastBoard = 0;
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
    // A changed valuation model or a new report moves the fair value without jumping any price.
    this.summaries.forEach((s, i) => s.fair && this.market.setFair(i, s.fair.cents));
    this.regime = this.market.regime();
    for (const ev of await store.liveEvents(this.sql, state.seq, ASSETS)) this.track(ev);
    this.news = await store.recentNews(this.sql, NEWS_KEPT);
    await this.loadTapes();

    const row = await store.liveSession(this.sql);
    if (row) await this.resume(row);
    else await this.newSession();
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
    return live.startSeq === null ? 0 : this.market.seq - live.startSeq;
  }

  private async pump() {
    if (this.busy || !this.live || this.fenced) return;
    this.busy = true;
    try {
      const live = this.live;
      const now = Date.now();
      // An empty room keeps waiting rather than running a market nobody trades: an always-on box
      // would otherwise move the shared market for no one.
      if (live.startSeq === null && now >= live.opensAt && live.players.size === 0) {
        live.opensAt = now + this.cfg.lobbySeconds * 1000;
        live.closesAt = live.opensAt + live.cfg.totalTicks * live.cfg.tickMs;
        await store.setSessionTimes(this.sql, live.row.id, new Date(live.opensAt), new Date(live.closesAt));
        this.broadcastPhase();
      }
      const phase = phaseAt(now, live.opensAt, live.closesAt, live.cfg.closingSeconds, live.finishedAt !== null);

      if ((phase === 'trading' || phase === 'closing') && now >= this.retryAt) {
        if (live.startSeq === null) await this.open(live);
        const target = live.startSeq! + Math.min(live.cfg.totalTicks, Math.floor((now - live.opensAt) / live.cfg.tickMs));
        metrics.tickLagMs = Math.max(0, now - live.opensAt - this.localTick(live) * live.cfg.tickMs - live.cfg.tickMs);
        while (this.market.seq < target) this.stepOnce(live, true);
      }
      if (phase !== live.phase) {
        live.phase = phase;
        this.broadcastPhase();
      }
      if (phase === 'results' && live.finishedAt === null && now >= this.retryAt) await this.finish(live);
      if (live.finishedAt !== null && now >= live.finishedAt + live.cfg.resultsSeconds * 1000) await this.newSession();
      if (phase !== 'results' && now - this.lastBoard >= BOARD_MS) {
        this.lastBoard = now;
        this.broadcastBoard();
      }
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
   * same transaction that opens it; the market starts from wherever the last competition left it.
   */
  private async open(live: Live) {
    const tickMs = live.cfg.tickMs;
    const events = schedule(Number(live.row.seed), {
      assets: ASSETS,
      reports: (i) => this.reports.get(ASSETS[i]!.ticker) ?? [],
      ticksPerSecond: 1000 / tickMs,
      maxTick: live.cfg.totalTicks,
      at: (tick) => live.opensAt + tick * tickMs,
    }, live.cfg.totalTicks);
    const opening = Object.fromEntries(ASSETS.map((a, i) => [a.ticker, this.market.prices[i]!]));
    const opened = await store.openSession(this.sql, live.row.id, this.market.seq, opening, events, ASSETS);
    live.startSeq = opened.startSeq;
    live.row.status = 'trading';
    live.open = Array.from(this.market.prices);
    for (const ev of opened.events) if (ev.status === 'scheduled') this.track(ev);
    this.log.info({ session: live.row.id, startSeq: live.startSeq, events: opened.events.length }, 'bell rung');
  }

  private atOf(live: Live, seq: number) {
    return live.opensAt + (seq - live.startSeq!) * live.cfg.tickMs;
  }

  private stepOnce(live: Live, broadcast: boolean) {
    const next = this.market.seq + 1;
    let before: number[] | null = null;
    for (const ev of this.events.values()) {
      if (ev.seq !== next || ev.status !== 'scheduled') continue;
      before ??= Array.from(this.market.prices);
      if (ev.severity >= 2) live.windows.push({ endSeq: ev.seq + ev.duration, start: this.values(live) });
    }

    const fired = this.market.step();
    const seq = this.market.seq;
    const at = this.atOf(live, seq);
    this.lastAt = at;
    const tick = this.localTick(live);
    ASSETS.forEach((a, i) => this.buffer.prices.push({ ticker: a.ticker, seq, at, sessionId: live.row.id, price: this.market.prices[i]! }));
    metrics.ticks++;
    if (broadcast) this.broadcast({ t: 'tick', k: seq, at, p: Array.from(this.market.prices) });

    for (const sim of fired) {
      const ev = this.events.get(sim.id);
      if (!ev) continue;
      this.publish(ev, at, broadcast);
      const endSeq = Math.min(seq + Math.round(REACTION_MS / live.cfg.tickMs), live.startSeq! + live.cfg.totalTicks);
      if (before) this.tapes.set(ev.id, { seq, endSeq, before, after: null });
    }
    for (const t of this.tapes.values()) if (!t.after && seq >= t.endSeq) t.after = Array.from(this.market.prices);
    if (fired.length) for (const id of this.tapes.keys()) if (!this.news.some((n) => n.id === id)) this.tapes.delete(id);
    const regime = this.market.regime();
    if (regime !== this.regime) {
      this.regime = regime;
      if (broadcast) this.broadcast({ t: 'regime', regime });
    }

    const end = tick === live.cfg.totalTicks;
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
      for (const p of live.players.values()) p.samples.push(this.valueOf(p));
    }
    if (tick % CHECKPOINT_EVERY === 0 || end) void this.checkpoint();
    if (tick % SNAPSHOT_EVERY === 0) {
      this.background(store.recordSnapshot(this.sql, live.row.id, tick, this.ranking(live).slice(0, 50).map(this.row)), 'snapshot');
    }
  }

  /** A story lands: it goes out to everyone at once, and an earnings story files its report. */
  private publish(ev: store.StoredEvent, at: number, broadcast: boolean) {
    ev.status = 'published';
    ev.publishedAt = at;
    this.buffer.published.push({ id: ev.id, at });
    metrics.eventsPublished++;
    const info = eventInfo(ev);
    this.news = [info, ...this.news.filter((n) => n.id !== ev.id)].slice(0, NEWS_KEPT);
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
        if (broadcast) this.broadcast({ t: 'fund', ticker: ev.report.ticker, fund: this.summaries[i]! });
      }
    }
    if (broadcast) this.broadcast({ t: 'event', ev: info });
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
        ? { ...c, prices: [...f.prices, ...c.prices], published: [...f.published, ...c.published], cancelled: [...f.cancelled, ...c.cancelled], reports: [...f.reports, ...c.reports] }
        : c;
      job.prevSeq = this.savedSeq;
      if (job.state.seq === this.savedSeq && !f && !c.prices.length && !c.cancelled.length) return true;
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
      opensAt: row.opens_at.getTime(),
      closesAt: row.closes_at.getTime(),
      startSeq: row.start_seq === null ? null : Number(row.start_seq),
      open: row.opening_prices ? ASSETS.map((a, i) => row.opening_prices![a.ticker] ?? this.market.prices[i]!) : Array.from(this.market.prices),
      players: new Map(),
      phase: 'lobby',
      windows: [],
      finishing: false,
      finishedAt: null,
      results: null,
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
    this.live = this.build(row);
    metrics.players = 0;
    this.log.info({ session: row.id, opensAt }, 'session created');
    // Everyone still connected from the last session is dealt into the new one.
    await Promise.all(
      [...this.clients.values()].map((set) => {
        const first = set.values().next().value;
        return first ? this.ensurePlayer(first.userId, first.nickname) : null;
      }),
    );
    for (const set of this.clients.values()) for (const c of set) this.sendHello(c);
  }

  /** Restart recovery: books from the database, the market from its checkpoint, replayed to now. */
  private async resume(row: store.SessionRow) {
    const live = this.build(row);
    for (const p of await store.loadParticipants(this.sql, row.id)) {
      live.players.set(p.userId, {
        id: p.id, userId: p.userId, nickname: p.nickname, joinedAt: p.joinedAt.getTime(),
        book: { cash: p.cash, positions: p.positions }, trades: p.trades, chain: Promise.resolve(), samples: [], eventGain: 0,
      });
    }
    // shortcut: value samples and event windows before the restart are lost, so the two secondary
    // awards only cover the time since; persist samples if restarts mid-session become routine.
    const now = Date.now();
    // Set before the catch-up: replayed ticks record snapshots, which read the live competition.
    this.live = live;
    // Only a competition that actually opened has ticks to catch up. A lobby whose bell time passed
    // while the server was down never traded: the pump restarts its countdown.
    if (live.startSeq !== null && now > live.opensAt) {
      const target = live.startSeq + Math.min(live.cfg.totalTicks, Math.floor((now - live.opensAt) / live.cfg.tickMs));
      while (this.market.seq < target) this.stepOnce(live, false);
    }
    live.phase = phaseAt(now, live.opensAt, live.closesAt, live.cfg.closingSeconds, false);
    metrics.players = live.players.size;
    this.log.info({ session: row.id, seq: this.market.seq, players: live.players.size }, 'session resumed');
  }

  private async finish(live: Live) {
    if (!live.finishing) {
      live.finishing = true;
      while (this.localTick(live) < live.cfg.totalTicks) this.stepOnce(live, true);
      // An early close ends every reaction window at the final bell.
      for (const t of this.tapes.values()) if (!t.after) [t.after, t.endSeq] = [Array.from(this.market.prices), this.market.seq];
      // Orders that passed the phase check before the bell still settle; nothing new gets in.
      await Promise.allSettled([...live.players.values()].map((p) => p.chain));
      // Stories that never landed (an early close) are cancelled, never carried into the next competition.
      for (const ev of this.market.cancelPending()) {
        const stored = this.events.get(ev.id);
        if (stored) stored.status = 'cancelled';
        this.buffer.cancelled.push(ev.id);
      }
      for (const [id, ev] of this.events) if (ev.status !== 'scheduled') this.events.delete(id);
    }
    // The closing prices are durable before anyone is ranked on them.
    if (!(await this.checkpoint())) throw new Error('closing checkpoint not durable yet');

    const ranking = this.ranking(live);
    const finishedAt = Date.now();
    const start = live.cfg.startingCash;
    const closing = Object.fromEntries(ASSETS.map((a, i) => [a.ticker, this.market.prices[i]!]));

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
    const priceOf = (t: string) => this.market.prices[TICKER_INDEX.get(t)!]!;
    for (const s of scored) {
      const pnl = pnlByTicker(s.p.book, priceOf).sort((a, b) => b.pnl - a.pnl);
      const best = pnl[0] && pnl[0].pnl > 0 ? pnl[0] : null;
      const worst = pnl.at(-1) && pnl.at(-1)!.pnl < 0 ? pnl.at(-1)! : null;
      all.set(s.p.userId, {
        participantId: s.p.id, nickname: s.p.nickname, rank: s.rank, of: scored.length, value: s.value, bps: returnBps(s.value, start), start,
        cash: s.p.book.cash, trades: s.p.trades, best, worst,
        awards: awards.filter((a) => a.nickname === s.p.nickname).map((a) => a.id),
        sessionId: live.row.id, finishedAt,
      });
    }

    await store.recordSnapshot(this.sql, live.row.id, this.localTick(live), ranking.map(this.row));
    await store.finishSession(this.sql, live.row.id, closing, [...all.values()]);
    live.results = { top: [...all.values()].slice(0, BOARD_SIZE), awards, all };
    live.finishedAt = finishedAt;
    live.phase = 'results';
    this.log.info({ session: live.row.id, players: all.size, winner: winner?.p.nickname, seq: this.market.seq }, 'session finished');
    this.broadcastPhase();
    for (const set of this.clients.values()) for (const c of set) this.send(c, { t: 'results', results: this.resultsFor(c.userId)! });
  }

  /** Opens the bell now. Returns false when there is no lobby to open. */
  async openNow(): Promise<boolean> {
    const live = this.live;
    if (!live || Date.now() >= live.opensAt) return false;
    const opensAt = Date.now();
    const closesAt = opensAt + live.cfg.totalTicks * live.cfg.tickMs;
    await store.setSessionTimes(this.sql, live.row.id, new Date(opensAt), new Date(closesAt));
    live.opensAt = opensAt;
    live.closesAt = closesAt;
    this.log.info({ session: live.row.id }, 'bell opened early by admin');
    return true;
  }

  /** Rings the final bell now. The next pump values every purse and publishes the results. */
  async closeNow(): Promise<boolean> {
    const live = this.live;
    const now = Date.now();
    if (!live || live.startSeq === null || live.finishing || now >= live.closesAt) return false;
    // The tape never runs past the bell: the competition ends at the last tick already played.
    const tick = this.localTick(live);
    live.cfg.totalTicks = tick;
    live.closesAt = Math.min(now, live.opensAt + tick * live.cfg.tickMs);
    await store.setCloseTime(this.sql, live.row.id, new Date(live.closesAt));
    this.log.info({ session: live.row.id, tick }, 'market closed early by admin');
    return true;
  }

  /** Skips the rest of the results screen and opens the next lobby. */
  nextNow(): boolean {
    const live = this.live;
    if (!live || live.finishedAt === null) return false;
    live.finishedAt = Date.now() - live.cfg.resultsSeconds * 1000;
    return true;
  }

  /** What the host console shows: no player identity, just the room. */
  hostView() {
    const live = this.live;
    const b = live ? this.board(live) : null;
    return {
      serverNow: Date.now(),
      session: this.sessionInfo(),
      board: { top: b?.top ?? [], count: b?.count ?? 0 },
      events: this.news.filter((e) => e.sessionId === live?.row.id).slice(0, 6),
      results: live?.results ? { top: live.results.top, awards: live.results.awards } : null,
    };
  }

  // ---------------------------------------------------------------- research data

  /** The listing with every company's fundamentals summary, serialised once per change. */
  marketJsonBody(): string {
    this.marketJson ??= JSON.stringify({
      assets: ASSETS.map((a, i) => ({
        ticker: a.ticker, name: a.name, exchange: a.exchange, sector: a.sector, industry: a.industry, description: a.description,
        beta: a.beta, risk: risk(a.vol), fund: this.summaries[i]!,
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
  reactions(): Reaction[] {
    const now = this.market.prices;
    return this.news.flatMap((ev) => {
      const tape = this.tapes.get(ev.id);
      if (!tape) return [];
      const { subject, tickers } = reactionMembers(ev, ASSETS);
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

  /** Trading activity per company in the current competition, cached briefly: a whole room asks at once. */
  async activity(): Promise<Activity> {
    const id = this.live?.row.id ?? null;
    if (this.activityCache && this.activityCache.until > Date.now() && this.activityCache.body.sessionId === id) return this.activityCache.body;
    const body: Activity = { sessionId: id, rows: id ? await store.tradeActivity(this.sql, id) : [] };
    this.activityCache = { until: Date.now() + 5000, body };
    return body;
  }

  companyReports(ticker: string): Report[] | null {
    return TICKER_INDEX.has(ticker) ? (this.reports.get(ticker) ?? []) : null;
  }

  participantOf(userId: string): string | null {
    return this.live?.players.get(userId)?.id ?? null;
  }

  // ---------------------------------------------------------------- players and orders

  private async ensurePlayer(userId: string, nickname: string): Promise<Player | null> {
    const live = this.live;
    if (!live || live.finishing || live.finishedAt !== null) return null;
    const existing = live.players.get(userId);
    if (existing) return existing;
    if (live.players.size >= live.cfg.maxPlayers) return null;
    // Two tabs connecting at once must not race the insert.
    const pending = this.joining.get(userId);
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
      metrics.players = live.players.size;
      return p;
    })().finally(() => this.joining.delete(userId));
    this.joining.set(userId, job);
    return job;
  }

  async attach(c: Client) {
    let set = this.clients.get(c.userId);
    if (!set) this.clients.set(c.userId, (set = new Set()));
    set.add(c);
    metrics.sockets++;
    await this.ensurePlayer(c.userId, c.nickname);
    this.sendHello(c);
  }

  detach(c: Client) {
    const set = this.clients.get(c.userId);
    if (set?.delete(c)) metrics.sockets--;
    if (set && set.size === 0) this.clients.delete(c.userId);
  }

  order(c: Client, msg: ClientMsg): Promise<void> {
    const p = this.live?.players.get(c.userId);
    if (!p) {
      this.send(c, { t: 'reject', id: msg.id, reason: 'not_in_session' });
      return Promise.resolve();
    }
    const job = p.chain.then(() => this.execute(p, msg));
    p.chain = job;
    return job;
  }

  /** Fills against the market's current price. Nothing here feeds back into the market: orders never move prices. */
  private async execute(p: Player, msg: ClientMsg) {
    const started = performance.now();
    const live = this.live!;
    const reply = (m: ServerMsg) => this.sendUser(p.userId, m);
    const reject = (reason: Extract<ServerMsg, { t: 'reject' }>['reason']) => {
      metrics.orders.rejected++;
      reply({ t: 'reject', id: msg.id, reason });
    };

    const phase = phaseAt(Date.now(), live.opensAt, live.closesAt, live.cfg.closingSeconds, live.finishedAt !== null);
    if (live.finishing || live.startSeq === null || (phase !== 'trading' && phase !== 'closing') || !live.players.has(p.userId)) return reject('market_closed');
    const idx = TICKER_INDEX.get(msg.ticker);
    if (idx === undefined) return reject('unknown_asset');

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
    metrics.orders.filled++;
    metrics.orderLatencyMs.sum += performance.now() - started;
    metrics.orderLatencyMs.count++;
    reply({
      t: 'fill', id: msg.id, side: fill.side, ticker: fill.ticker, qty: fill.qty, price: fill.price, total: fill.total, realized: fill.realized, book: bookInfo(p),
      trade: { id: tradeId, at: Date.now(), ticker: fill.ticker, side: fill.side, qty: fill.qty, price: fill.price, total: fill.total, realized: fill.realized },
    });
  }

  // ---------------------------------------------------------------- views

  private valueOf(p: Player) {
    return valueOf(p.book, (t) => this.market.prices[TICKER_INDEX.get(t)!]!);
  }

  private values(live: Live): Map<string, number> {
    return new Map([...live.players.values()].map((p) => [p.userId, this.valueOf(p)]));
  }

  private ranking(live: Live) {
    return [...live.players.values()]
      .map((p) => ({ p, nickname: p.nickname, joinedAt: p.joinedAt, value: this.valueOf(p) }))
      .sort(compareRank)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  private row = (r: { rank: number; nickname: string; value: number; p: Player }) => {
    let top: string | null = null;
    let most = 0;
    for (const [ticker, pos] of r.p.book.positions) {
      const v = pos.qty * this.market.prices[TICKER_INDEX.get(ticker)!]!;
      if (v > most) [top, most] = [ticker, v];
    }
    return { rank: r.rank, nickname: r.nickname, value: r.value, bps: returnBps(r.value, this.live!.cfg.startingCash), trades: r.p.trades, top };
  };

  sessionInfo(): SessionInfo | null {
    const live = this.live;
    if (!live) return null;
    return {
      id: live.row.id,
      phase: live.phase,
      opensAt: live.opensAt,
      closingAt: live.closesAt - live.cfg.closingSeconds * 1000,
      closesAt: live.closesAt,
      nextAt: live.finishedAt === null ? null : live.finishedAt + live.cfg.resultsSeconds * 1000,
      tick: this.localTick(live),
      totalTicks: live.cfg.totalTicks,
      tickMs: live.cfg.tickMs,
      players: live.players.size,
      maxPlayers: live.cfg.maxPlayers,
      startingCash: live.cfg.startingCash,
    };
  }

  private board(live: Live): { top: Board['top']; count: number; me: Map<string, Board['me']> } {
    const ranking = this.ranking(live);
    return {
      top: ranking.slice(0, BOARD_SIZE).map(this.row),
      count: ranking.length,
      me: new Map(ranking.map((r) => [r.p.userId, { rank: r.rank, value: r.value }])),
    };
  }

  private resultsFor(userId: string): Results | null {
    const r = this.live?.results;
    if (!r) return null;
    return { sessionId: this.live!.row.id, top: r.top, awards: r.awards, me: r.all.get(userId) ?? null };
  }

  private sendHello(c: Client) {
    const live = this.live;
    const p = live?.players.get(c.userId);
    const b = live ? this.board(live) : null;
    this.send(c, {
      t: 'hello',
      serverNow: Date.now(),
      you: { userId: c.userId, nickname: c.nickname },
      session: this.sessionInfo(),
      tickers: TICKERS,
      seq: this.market.seq,
      at: this.lastAt,
      prices: Array.from(this.market.prices),
      open: live?.open ?? Array.from(this.market.prices),
      regime: this.regime,
      events: this.news,
      book: p ? bookInfo(p) : null,
      spectating: p ? null : live && (live.finishedAt !== null || live.finishing) ? 'closed' : 'full',
      board: { top: b?.top ?? [], count: b?.count ?? 0, me: b?.me.get(c.userId) ?? null },
      results: this.resultsFor(c.userId),
    });
  }

  // ---------------------------------------------------------------- transport

  private send(c: Client, msg: ServerMsg) {
    const data = JSON.stringify(msg);
    metrics.bytesOut += data.length;
    c.send(data);
  }

  private sendUser(userId: string, msg: ServerMsg) {
    for (const c of this.clients.get(userId) ?? []) this.send(c, msg);
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const set of this.clients.values()) for (const c of set) {
      metrics.bytesOut += data.length;
      c.send(data);
    }
  }

  private broadcastPhase() {
    const session = this.sessionInfo();
    if (session) this.broadcast({ t: 'phase', serverNow: Date.now(), session, open: this.live!.open });
  }

  private broadcastBoard() {
    const live = this.live;
    if (!live) return;
    const b = this.board(live);
    // The shared part is serialised once; only the per-player tail differs.
    const head = `{"t":"board","board":{"top":${JSON.stringify(b.top)},"count":${b.count},"me":`;
    for (const [userId, set] of this.clients) {
      const data = `${head}${JSON.stringify(b.me.get(userId) ?? null)}}}`;
      for (const c of set) {
        metrics.bytesOut += data.length;
        c.send(data);
      }
    }
  }
}
