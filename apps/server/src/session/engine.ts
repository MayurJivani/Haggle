import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import type { Sql } from '../db/db.js';
import { ASSETS } from '../market/assets.js';
import { schedule, type ScheduledEvent } from '../market/events.js';
import { MarketSim } from '../market/sim.js';
import { metrics } from '../metrics.js';
import type { AssetInfo, Board, BookInfo, ClientMsg, EventInfo, PlayerResult, Results, ServerMsg, SessionInfo } from '../protocol.js';
import { apply, pnlByTicker, quote, returnBps, valueOf, type Book } from '../trading/portfolio.js';
import { compareRank, phaseAt, sharpe, type Phase } from './ranking.js';
import * as store from './store.js';

export interface EngineConfig {
  lobbySeconds: number;
  tradingSeconds: number;
  closingSeconds: number;
  resultsSeconds: number;
  tickMs: number;
  maxPlayers: number;
  seed?: number;
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

interface Window {
  endTick: number;
  start: Map<string, number>;
}

interface Live {
  row: store.SessionRow;
  cfg: store.SessionConfig;
  opensAt: number;
  closesAt: number;
  sim: MarketSim;
  history: Int32Array[];
  fired: EventInfo[];
  players: Map<string, Player>;
  phase: Phase;
  windows: Window[];
  flushedTick: number;
  finishing: boolean;
  finishedAt: number | null;
  results: { top: PlayerResult[]; awards: Results['awards']; all: Map<string, PlayerResult> } | null;
}

const eur = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const SAMPLE_EVERY = 10;
const FLUSH_EVERY = 10;
const SNAPSHOT_EVERY = 30;
const BOARD_MS = 2000;
const BOARD_SIZE = 10;
const HISTORY_POINTS = 150;

const ASSET_INFO: AssetInfo[] = ASSETS.map(({ ticker, name, sector, description, base, vol, beta, sens }) => ({
  ticker, name, sector, description, base, vol, beta, sens: sens as Record<string, number>,
}));
const TICKER_INDEX = new Map(ASSETS.map((a, i) => [a.ticker, i]));

const eventInfo = (ev: ScheduledEvent): EventInfo => ({
  seq: ev.seq, tick: ev.tick, template: ev.template, scope: ev.scope, target: ev.target, headline: ev.headline,
  description: ev.description, severity: ev.severity, duration: ev.duration,
  effects: ev.effects.map((e) => ({ ticker: ASSETS[e.asset]!.ticker, bps: Math.round(e.pct * 10_000) })),
});

const bookInfo = (p: Player): BookInfo => ({
  participantId: p.id,
  cash: p.book.cash,
  positions: [...p.book.positions].filter(([, x]) => x.qty > 0 || x.realized !== 0).map(([ticker, x]) => ({ ticker, ...x })),
  trades: p.trades,
});

export class Engine {
  live: Live | null = null;
  private readonly clients = new Map<string, Set<Client>>();
  private readonly joining = new Map<string, Promise<Player | null>>();
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
    await store.upsertAssets(this.sql, ASSETS);
    const row = await store.liveSession(this.sql);
    if (row) await this.resume(row);
    else await this.newSession();
    this.timer = setInterval(() => void this.pump(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- clock

  private async pump() {
    if (this.busy || !this.live) return;
    this.busy = true;
    try {
      const live = this.live;
      const now = Date.now();
      const phase = phaseAt(now, live.opensAt, live.closesAt, live.cfg.closingSeconds, live.finishedAt !== null);

      if (phase === 'trading' || phase === 'closing') {
        if (live.row.status === 'lobby') {
          live.row.status = 'trading';
          await store.markTrading(this.sql, live.row.id);
        }
        const target = Math.min(live.cfg.totalTicks, Math.floor((now - live.opensAt) / live.cfg.tickMs));
        metrics.tickLagMs = Math.max(0, now - live.opensAt - live.sim.tick * live.cfg.tickMs - live.cfg.tickMs);
        while (live.sim.tick < target) this.stepOnce(live, true);
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

  private stepOnce(live: Live, broadcast: boolean) {
    const next = live.sim.tick + 1;
    for (const ev of live.sim.events) {
      if (ev.tick === next && ev.severity >= 2) live.windows.push({ endTick: ev.tick + ev.duration, start: this.values(live) });
    }

    const fired = live.sim.step();
    const tick = live.sim.tick;
    live.sim.prices.forEach((p, i) => (live.history[i]![tick] = p));
    metrics.ticks++;
    if (broadcast) this.broadcast({ t: 'tick', k: tick, p: Array.from(live.sim.prices) });

    for (const ev of fired) {
      const info = eventInfo(ev);
      live.fired.push(info);
      if (broadcast) this.broadcast({ t: 'event', ev: info });
      this.background(store.recordEvent(this.sql, live.row.id, ev, ASSETS), 'record event');
    }

    const closing = live.windows.filter((w) => w.endTick <= tick || tick === live.cfg.totalTicks);
    if (closing.length) {
      const now = this.values(live);
      for (const w of closing) for (const [id, v0] of w.start) {
        const p = live.players.get(id);
        if (p) p.eventGain += (now.get(id) ?? v0) - v0;
      }
      live.windows = live.windows.filter((w) => !closing.includes(w));
    }

    if (tick % SAMPLE_EVERY === 0 || tick === live.cfg.totalTicks) {
      for (const p of live.players.values()) p.samples.push(this.valueOf(live, p));
    }
    if (tick % FLUSH_EVERY === 0 || tick === live.cfg.totalTicks) this.flushPrices(live);
    if (tick % SNAPSHOT_EVERY === 0) {
      this.background(store.recordSnapshot(this.sql, live.row.id, tick, this.ranking(live).slice(0, 50).map(this.row)), 'snapshot');
    }
  }

  private flushPrices(live: Live) {
    const from = live.flushedTick + 1;
    const to = live.sim.tick;
    if (to < from) return;
    live.flushedTick = to;
    this.background(
      store.recordPrices(this.sql, live.row.id, ASSETS.map((a) => a.ticker), from, live.history, to),
      'record prices',
    );
  }

  private background(p: Promise<unknown>, what: string) {
    p.catch((err) => {
      metrics.dbErrors++;
      this.log.error({ err }, `${what} failed`);
    });
  }

  // ---------------------------------------------------------------- session lifecycle

  private build(row: store.SessionRow): Live {
    const cfg = row.config;
    const sim = new MarketSim(Number(row.seed), ASSETS, schedule(Number(row.seed), ASSETS, cfg.totalTicks, cfg.tickMs));
    const history = ASSETS.map((a) => {
      const h = new Int32Array(cfg.totalTicks + 1);
      h[0] = a.base;
      return h;
    });
    return {
      row, cfg, sim, history,
      opensAt: row.opens_at.getTime(),
      closesAt: row.closes_at.getTime(),
      fired: [],
      players: new Map(),
      phase: 'lobby',
      windows: [],
      flushedTick: -1,
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
    };
    const row = await store.createSession(this.sql, this.cfg.seed ?? randomInt(2 ** 31), opensAt, closesAt, cfg);
    this.live = this.build(row);
    this.flushPrices(this.live);
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

  /** Restart recovery: rebuild the tape by replaying the seed, and the books from the database. */
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
    if (now > live.opensAt) {
      const target = Math.min(live.cfg.totalTicks, Math.floor((now - live.opensAt) / live.cfg.tickMs));
      while (live.sim.tick < target) this.stepOnce(live, false);
    }
    live.phase = phaseAt(now, live.opensAt, live.closesAt, live.cfg.closingSeconds, false);
    this.live = live;
    metrics.players = live.players.size;
    this.log.info({ session: row.id, tick: live.sim.tick, players: live.players.size }, 'session resumed');
  }

  private async finish(live: Live) {
    if (!live.finishing) {
      live.finishing = true;
      while (live.sim.tick < live.cfg.totalTicks) this.stepOnce(live, true);
      // Orders that passed the phase check before the bell still settle; nothing new gets in.
      await Promise.allSettled([...live.players.values()].map((p) => p.chain));
    }
    const ranking = this.ranking(live);
    const finishedAt = Date.now();
    const closing = Object.fromEntries(ASSETS.map((a, i) => [a.ticker, live.sim.prices[i]!]));

    const scored = ranking.map((r) => ({ ...r, sharpe: r.p.trades > 0 ? sharpe(r.p.samples) : null }));
    const awards: Results['awards'] = [];
    const award = (id: string, label: string, pick: (typeof scored)[number] | undefined, detail: string) => {
      if (pick) awards.push({ id, label, nickname: pick.p.nickname, detail });
    };
    const winner = scored[0];
    if (winner) award('winner', 'Top of the market', winner, `finished with ${eur(winner.value)}`);
    const steady = scored.filter((s) => s.sharpe !== null && s.value > 100_000).sort((a, b) => b.sharpe! - a.sharpe!)[0];
    award('steady', 'Steadiest hand', steady, 'best risk-adjusted return');
    const eventer = scored.filter((s) => s.p.eventGain > 0).sort((a, b) => b.p.eventGain - a.p.eventGain || compareRank(a, b))[0];
    if (eventer) award('crier', 'Read the crier', eventer, `+${eur(eventer.p.eventGain)} during major events`);

    const all = new Map<string, PlayerResult>();
    const priceOf = (t: string) => live.sim.prices[TICKER_INDEX.get(t)!]!;
    for (const s of scored) {
      const pnl = pnlByTicker(s.p.book, priceOf).sort((a, b) => b.pnl - a.pnl);
      const best = pnl[0] && pnl[0].pnl > 0 ? pnl[0] : null;
      const worst = pnl.at(-1) && pnl.at(-1)!.pnl < 0 ? pnl.at(-1)! : null;
      all.set(s.p.userId, {
        participantId: s.p.id, nickname: s.p.nickname, rank: s.rank, of: scored.length, value: s.value, bps: returnBps(s.value),
        cash: s.p.book.cash, trades: s.p.trades, best, worst,
        awards: awards.filter((a) => a.nickname === s.p.nickname).map((a) => a.id),
        sessionId: live.row.id, finishedAt,
      });
    }

    this.flushPrices(live);
    await store.recordSnapshot(this.sql, live.row.id, live.sim.tick, ranking.map(this.row));
    await store.finishSession(this.sql, live.row.id, closing, [...all.values()]);
    live.results = { top: [...all.values()].slice(0, BOARD_SIZE), awards, all };
    live.finishedAt = finishedAt;
    live.phase = 'results';
    this.log.info({ session: live.row.id, players: all.size, winner: winner?.p.nickname }, 'session finished');
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
      const { id, joinedAt } = await store.joinSession(this.sql, live.row.id, userId);
      const p: Player = {
        id, userId, nickname, joinedAt: joinedAt.getTime(), book: { cash: 100_000, positions: new Map() },
        trades: 0, chain: Promise.resolve(), samples: [], eventGain: 0,
      };
      if (live.sim.tick > 0) p.samples.push(100_000);
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

  private async execute(p: Player, msg: ClientMsg) {
    const started = performance.now();
    const live = this.live!;
    const reply = (m: ServerMsg) => this.sendUser(p.userId, m);
    const reject = (reason: Extract<ServerMsg, { t: 'reject' }>['reason']) => {
      metrics.orders.rejected++;
      reply({ t: 'reject', id: msg.id, reason });
    };

    const phase = phaseAt(Date.now(), live.opensAt, live.closesAt, live.cfg.closingSeconds, live.finishedAt !== null);
    if (live.finishing || (phase !== 'trading' && phase !== 'closing') || !live.players.has(p.userId)) return reject('market_closed');
    const idx = TICKER_INDEX.get(msg.ticker);
    if (idx === undefined) return reject('unknown_asset');

    const fill = quote(p.book, msg.side, msg.ticker, msg.qty, live.sim.prices[idx]!);
    if (!fill.ok) return reject(fill.reason);

    try {
      await store.recordFill(this.sql, p.id, msg.id, fill, live.sim.tick);
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
    reply({ t: 'fill', id: msg.id, side: fill.side, ticker: fill.ticker, qty: fill.qty, price: fill.price, total: fill.total, realized: fill.realized, book: bookInfo(p) });
  }

  // ---------------------------------------------------------------- views

  private valueOf(live: Live, p: Player) {
    return valueOf(p.book, (t) => live.sim.prices[TICKER_INDEX.get(t)!]!);
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

  private row = (r: { rank: number; nickname: string; value: number; p: Player }) => {
    let top: string | null = null;
    let most = 0;
    for (const [ticker, pos] of r.p.book.positions) {
      const v = pos.qty * this.live!.sim.prices[TICKER_INDEX.get(ticker)!]!;
      if (v > most) [top, most] = [ticker, v];
    }
    return { rank: r.rank, nickname: r.nickname, value: r.value, bps: returnBps(r.value), trades: r.p.trades, top };
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
      tick: live.sim.tick,
      totalTicks: live.cfg.totalTicks,
      tickMs: live.cfg.tickMs,
      players: live.players.size,
      maxPlayers: live.cfg.maxPlayers,
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
    const tick = live?.sim.tick ?? 0;
    const step = Math.max(1, Math.ceil((tick + 1) / HISTORY_POINTS));
    const prices = (live?.history ?? []).map((h) => {
      const out: number[] = [];
      for (let t = 0; t < tick; t += step) out.push(h[t]!);
      out.push(h[tick]!);
      return out;
    });
    const b = live ? this.board(live) : null;
    this.send(c, {
      t: 'hello',
      serverNow: Date.now(),
      you: { userId: c.userId, nickname: c.nickname },
      session: this.sessionInfo(),
      assets: ASSET_INFO,
      history: { step, prices },
      events: live?.fired ?? [],
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
    if (session) this.broadcast({ t: 'phase', serverNow: Date.now(), session });
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
