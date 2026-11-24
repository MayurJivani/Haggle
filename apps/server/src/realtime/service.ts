// Haggle RealTime: wires the catalogue, the price layer and the order engine to seasons, portfolios,
// leaderboards, notifications and the scheduled jobs. Owns nothing of the simulated game.
import type { Logger } from 'pino';
import type { Sql } from '../db/db.js';
import { addDays, EXCHANGES, sessionsOn, setOverride, wallToUtc, zoned, type ExchangeId } from './calendar.js';
import { Catalogue, HEADLINE_INDICES } from './catalogue.js';
import { markValue, returnBps } from './ledger.js';
import { exchangesTrading, Market } from './market.js';
import { Alpaca } from './providers/alpaca.js';
import { Dev } from './providers/dev.js';
import { Feeds } from './providers/feeds.js';
import type { Provider } from './providers/provider.js';
import { Tradegate } from './providers/tradegate.js';
import { TwelveData } from './providers/twelvedata.js';
import { Trading, type Policy } from './trading.js';
import type { Activity, BoardRow, Execution, FeedInfo, Instrument, LedgerEntry, Notification, Portfolio, PositionView, Season, ServerMsg } from './types.js';

export interface RealtimeConfig {
  providers: Provider[];
  startingCash: number;
  tz: string;
  policy: Policy;
  catalogueSync: boolean;
  tdKey: string;
  now: () => number;
  /** Background jobs (sync, snapshots, settlement). Off in tests that drive them by hand. */
  jobs: boolean;
}

export function providersFromEnv(env: {
  REALTIME_PROVIDERS: string[]; ALPACA_KEY_ID: string; ALPACA_SECRET_KEY: string; ALPACA_FEED: 'iex' | 'sip' | 'delayed_sip'; ALPACA_RATE_PER_MIN: number;
  ALPACA_STREAM_MAX: number; TWELVEDATA_API_KEY: string; TWELVEDATA_EXCHANGES: ExchangeId[]; TWELVEDATA_REALTIME: ExchangeId[]; TWELVEDATA_DELAY_MIN: number;
  TWELVEDATA_CREDITS_PER_MIN: number; TWELVEDATA_WS: boolean; TWELVEDATA_WS_MAX: number;
}, now: () => number): Provider[] {
  return env.REALTIME_PROVIDERS.map((id) => {
    if (id === 'alpaca') return new Alpaca({ keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY, feed: env.ALPACA_FEED, perMinute: env.ALPACA_RATE_PER_MIN, streamMax: env.ALPACA_STREAM_MAX });
    if (id === 'twelvedata') {
      return new TwelveData({
        apiKey: env.TWELVEDATA_API_KEY, exchanges: env.TWELVEDATA_EXCHANGES, realtime: env.TWELVEDATA_REALTIME, delayMin: env.TWELVEDATA_DELAY_MIN,
        perMinute: env.TWELVEDATA_CREDITS_PER_MIN, ws: env.TWELVEDATA_WS, streamMax: env.TWELVEDATA_WS_MAX,
      });
    }
    if (id === 'tradegate') return new Tradegate();
    return new Dev(now);
  });
}

interface SeasonRow {
  id: string; slug: string; name: string; kind: Season['kind']; starting_cash_cents: number; starts_at: Date; ends_at: Date | null; join_until: Date | null;
  rules: string; status: Season['status'];
}
interface AccountMark { id: string; user_id: string; nickname: string; cash_cents: number; starting_cash_cents: number; public: boolean }

const OPEN_RULES = 'Always on. Join any time with the starting cash; your return is measured against it. No end date and no prize, just the standing.';
const SNAPSHOT_MS = 15 * 60_000;

export interface Client {
  userId: string;
  send(m: ServerMsg): void;
  ids: Set<number>;
}

export class Realtime {
  readonly catalogue: Catalogue;
  readonly feeds: Feeds;
  readonly market: Market;
  readonly trading: Trading;
  private clients = new Set<Client>();
  private boards = new Map<string, BoardRow[]>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private dayOpen = new Map<number, number>();
  private news = new Map<string, { at: number; items: unknown }>();
  private moversCache: { at: number; value: unknown } | null = null;

  constructor(private sql: Sql, private log: Logger, readonly cfg: RealtimeConfig) {
    this.catalogue = new Catalogue(sql, log, cfg.tdKey);
    this.feeds = new Feeds(cfg.providers);
    this.market = new Market(sql, this.catalogue, this.feeds, log, { maxQuoteAgeMs: cfg.policy.maxQuoteAgeMs, now: cfg.now });
    this.trading = new Trading(sql, this.catalogue, this.market, cfg.policy, cfg.now, log);
  }

  get dev() {
    return this.cfg.providers.some((p) => p.id === 'dev');
  }

  async start() {
    await this.ensureSeasons();
    await this.loadOverrides();
    await this.market.start();
    await this.trading.start();
    await this.refreshInterest();
    this.market.onQuotes((qs) => this.broadcast(qs));
    this.trading.on((e) => {
      const msg: ServerMsg = e.kind === 'fill' ? { t: 'fill', execution: e.execution } : { t: 'order', order: e.order };
      this.sendTo(e.userId, msg);
      if (e.kind === 'fill' && e.order.type === 'limit') {
        const verb = e.execution.side === 'buy' ? 'Bought' : 'Sold';
        void this.notify(e.userId, 'fill', `Limit order filled: ${verb} ${fmtQty(e.execution.qty)} ${e.execution.instrument.symbol}`, null);
      }
      void this.refreshInterest();
    });
    if (this.cfg.jobs) this.startJobs();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    await this.trading.settle();
    await this.market.stop();
  }

  private every(ms: number, fn: () => Promise<unknown>, name: string) {
    const run = () => fn().catch((err) => this.log.warn({ err, job: name }, 'realtime job failed'));
    const t = setInterval(run, ms);
    t.unref();
    this.timers.push(t);
    return run;
  }

  private startJobs() {
    const catalogue = this.every(24 * 3600_000, async () => this.cfg.catalogueSync && (await this.catalogue.sync()), 'catalogue');
    // Empty, or from before Tradegate was added: sync now rather than in a day.
    void this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rt_instruments WHERE mic = 'XGAT'`.then(([r]) => r?.n === 0 && catalogue());
    void this.every(6 * 3600_000, () => this.market.syncFx(), 'fx')();
    void this.every(12 * 3600_000, () => this.syncCalendars(), 'calendar')();
    void this.every(6 * 3600_000, () => this.corporateActions(), 'corporate-actions')();
    this.every(SNAPSHOT_MS, () => this.snapshot(), 'snapshot');
    void this.every(60_000, () => this.housekeeping(), 'housekeeping')();
    this.every(30_000, () => this.computeBoards(), 'boards');
    this.every(60_000, () => this.refreshInterest(), 'interest');
  }

  // ---------------------------------------------------------------- clients

  attach(c: Client) {
    this.clients.add(c);
    c.send({ t: 'hello', userId: c.userId, serverNow: this.cfg.now() });
  }
  detach(c: Client) {
    this.market.view([...c.ids], -1);
    this.clients.delete(c);
  }
  subscribe(c: Client, ids: number[]) {
    const add = ids.filter((id) => !c.ids.has(id)).slice(0, Math.max(0, 300 - c.ids.size));
    for (const id of add) c.ids.add(id);
    this.market.view(add, 1);
    const cached = add.flatMap((id) => this.market.quote(id) ?? []);
    if (cached.length) c.send({ t: 'q', q: cached });
  }
  unsubscribe(c: Client, ids: number[]) {
    const drop = ids.filter((id) => c.ids.delete(id));
    this.market.view(drop, -1);
  }
  private broadcast(qs: { id: number }[]) {
    for (const c of this.clients) {
      const mine = qs.filter((q) => c.ids.has(q.id));
      if (mine.length) c.send({ t: 'q', q: mine as never });
    }
    void this.watchMoves(qs as never);
  }
  private sendTo(userId: string, m: ServerMsg) {
    for (const c of this.clients) if (c.userId === userId) c.send(m);
  }

  /** Instruments priced whoever watches: held, ordered, the overview's indices. */
  async refreshInterest() {
    const rows = await this.sql<{ instrument_id: number }[]>`
      SELECT DISTINCT p.instrument_id FROM rt_positions p JOIN rt_accounts a ON a.id = p.account_id JOIN rt_seasons s ON s.id = a.season_id
      WHERE p.qty > 0 AND s.status = 'active'
      UNION SELECT instrument_id FROM rt_orders WHERE status IN ('open', 'partially_filled')`;
    this.market.setHeld(rows.map((r) => r.instrument_id));
    const idx = await this.sql<{ id: number }[]>`
      SELECT i.id FROM rt_instruments i JOIN unnest(${HEADLINE_INDICES.map((x) => x.mic)}::text[], ${HEADLINE_INDICES.map((x) => x.symbol)}::text[]) AS h(mic, symbol)
        ON i.mic = h.mic AND i.symbol = h.symbol WHERE i.kind = 'index'`;
    this.market.setBackground(idx.map((r) => r.id));
  }

  feedInfo(): FeedInfo {
    const ups = this.market.streamUp();
    return {
      providers: this.feeds.info().map((p) => ({ ...p, detail: p.detail || (p.id in ups ? (ups[p.id] ? 'stream connected' : 'stream reconnecting, polling meanwhile') : 'polling') })),
      dev: this.dev,
      policy: {
        maxQuoteAgeSec: Math.round(this.cfg.policy.maxQuoteAgeMs / 1000), slippageBps: this.cfg.policy.slippageBps, delayedFills: this.cfg.policy.delayedFills,
        extendedHours: this.cfg.policy.extendedHours, partialFills: this.cfg.policy.partialFills, maxSpreadBps: this.cfg.policy.maxSpreadBps,
      },
    };
  }

  // ---------------------------------------------------------------- seasons

  /** The open season always exists; a weekly and a monthly competition are scheduled ahead in REALTIME_TZ. */
  async ensureSeasons() {
    const t = this.cfg.now();
    await this.sql`
      INSERT INTO rt_seasons (slug, name, kind, starting_cash_cents, starts_at, rules, status)
      VALUES ('open', 'Open market', 'open', ${this.cfg.startingCash * 100}, ${new Date(t)}, ${OPEN_RULES}, 'active')
      ON CONFLICT (slug) DO NOTHING`;
    const z = zoned(t, this.cfg.tz);
    const monday = addDays(z.date, -((z.weekday + 6) % 7));
    const firstOfMonth = `${z.date.slice(0, 8)}01`;
    const nextMonth = (d: string) => {
      const [y, m] = d.split('-').map(Number) as [number, number];
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    };
    const plan: { slug: string; name: string; kind: 'weekly' | 'monthly'; start: string; end: string; joinDays: number }[] = [];
    for (const w of [monday, addDays(monday, 7)]) plan.push({ slug: `week-${w}`, name: `Week of ${w}`, kind: 'weekly', start: w, end: addDays(w, 7), joinDays: 1 });
    for (const m of [firstOfMonth, nextMonth(firstOfMonth)]) plan.push({ slug: `month-${m.slice(0, 7)}`, name: `Month of ${m.slice(0, 7)}`, kind: 'monthly', start: m, end: nextMonth(m), joinDays: 3 });
    for (const p of plan) {
      const starts = wallToUtc(p.start, '00:00', this.cfg.tz);
      const ends = wallToUtc(p.end, '00:00', this.cfg.tz);
      if (ends <= t) continue;
      const join = Math.min(ends, wallToUtc(addDays(p.start, p.joinDays), '00:00', this.cfg.tz));
      const rules = `Everyone starts with the same cash at ${p.start} 00:00 (${this.cfg.tz}) and the standing is frozen at ${p.end} 00:00. ` +
        `Join until ${new Date(join).toISOString().slice(0, 16).replace('T', ' ')} UTC; later sign-ups wait for the next one, so nobody starts with a head start on the field.`;
      await this.sql`
        INSERT INTO rt_seasons (slug, name, kind, starting_cash_cents, starts_at, ends_at, join_until, rules, status)
        VALUES (${p.slug}, ${p.name}, ${p.kind}, ${this.cfg.startingCash * 100}, ${new Date(starts)}, ${new Date(ends)}, ${new Date(join)}, ${rules}, ${starts <= t ? 'active' : 'scheduled'})
        ON CONFLICT (slug) DO NOTHING`;
    }
    await this.sql`UPDATE rt_seasons SET status = 'active' WHERE status = 'scheduled' AND starts_at <= ${new Date(t)}`;
  }

  async seasons(userId: string | null): Promise<Season[]> {
    const rows = await this.sql<(SeasonRow & { players: number; joined: boolean })[]>`
      SELECT s.*, (SELECT count(*)::int FROM rt_accounts a WHERE a.season_id = s.id) AS players,
        EXISTS (SELECT 1 FROM rt_accounts a WHERE a.season_id = s.id AND a.user_id = ${userId}) AS joined
      FROM rt_seasons s ORDER BY (s.kind = 'open') DESC, s.status = 'finished', s.starts_at DESC LIMIT 40`;
    return rows.map(seasonView);
  }

  async season(idOrSlug: string): Promise<SeasonRow | null> {
    const uuid = /^[0-9a-f-]{36}$/.test(idOrSlug);
    const [s] = uuid
      ? await this.sql<SeasonRow[]>`SELECT * FROM rt_seasons WHERE id = ${idOrSlug}`
      : await this.sql<SeasonRow[]>`SELECT * FROM rt_seasons WHERE slug = ${idOrSlug}`;
    return s ?? null;
  }

  /** Ends seasons whose time is up: working orders are cancelled and the final standing is written. */
  async settleDue() {
    const due = await this.sql<SeasonRow[]>`SELECT * FROM rt_seasons WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ${new Date(this.cfg.now())}`;
    for (const s of due) {
      await this.sql`UPDATE rt_seasons SET status = 'finished' WHERE id = ${s.id}`;
      await this.trading.cancelSeason(s.id, 'The competition ended');
      const rows = await this.board(s.id, 'value', 100_000);
      if (rows.length) {
        await this.sql`
          INSERT INTO rt_season_results ${this.sql(rows.map((r) => ({
            season_id: s.id, account_id: r.accountId, rank: r.rank, final_value_cents: r.value, return_bps: r.returnBps, best_pick: r.bestPick as never,
          })), 'season_id', 'account_id', 'rank', 'final_value_cents', 'return_bps', 'best_pick')}
          ON CONFLICT DO NOTHING`;
        for (const r of rows.slice(0, 3)) void this.notify(r.userId, 'season', `${s.name} is over: you finished #${r.rank} of ${rows.length}.`, `season:${s.id}`);
      }
      this.log.info({ season: s.slug, players: rows.length }, 'season settled');
    }
  }

  // ---------------------------------------------------------------- portfolios

  private async markOf(i: Pick<Instrument, 'id' | 'currency' | 'exchange'>) {
    const q = this.market.quote(i.id);
    const fx = this.market.fx(i.currency);
    const price = q?.last ?? (q?.bid && q?.ask ? Math.round((q.bid + q.ask) / 2) : null);
    return { q, fx, price };
  }

  async portfolio(accountId: string): Promise<Portfolio | null> {
    const [a] = await this.sql<(AccountMark & { season_id: string; reserved_cents: number })[]>`
      SELECT a.id, a.user_id, u.nickname, a.cash_cents, a.reserved_cents, a.starting_cash_cents, a.season_id, coalesce(p.public, false) AS public
      FROM rt_accounts a JOIN users u ON u.id = a.user_id LEFT JOIN rt_profiles p ON p.user_id = a.user_id WHERE a.id = ${accountId}`;
    if (!a) return null;
    const season = (await this.season(a.season_id))!;
    const players = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rt_accounts WHERE season_id = ${a.season_id}`;
    const rows = await this.sql<{ instrument_id: number; qty: number; reserved_qty: number; cost_cents: number; realized_cents: number }[]>`
      SELECT instrument_id, qty, reserved_qty, cost_cents, realized_cents FROM rt_positions WHERE account_id = ${accountId}`;
    const instruments = await this.catalogue.many(rows.map((r) => r.instrument_id));
    const byId = new Map(instruments.map((i) => [i.id, i]));
    let invested = 0, unrealized = 0, realized = 0, dayPnl = 0, unpriced = 0;
    let dayKnown = true;
    const positions: PositionView[] = [];
    for (const r of rows) {
      realized += r.realized_cents;
      const i = byId.get(r.instrument_id);
      if (!i || r.qty === 0) continue;
      const { q, fx, price } = await this.markOf(i);
      const value = price && fx ? Number(markValue(BigInt(r.qty), BigInt(price), fx)) : null;
      if (value === null) unpriced++;
      invested += value ?? r.cost_cents;
      if (value !== null) unrealized += value - r.cost_cents;
      const prev = q?.prevClose;
      const dayChange = value !== null && prev && fx ? value - Number(markValue(BigInt(r.qty), BigInt(prev), fx)) : null;
      if (dayChange === null) dayKnown = false;
      else dayPnl += dayChange;
      positions.push({
        instrument: { id: i.id, symbol: i.symbol, name: i.name, exchange: i.exchange, currency: i.currency, status: i.status },
        qty: r.qty, reservedQty: r.reserved_qty, cost: r.cost_cents, realized: r.realized_cents, mark: price, markStatus: this.market.status(i),
        value, unrealized: value === null ? null : value - r.cost_cents, dayChange,
      });
    }
    positions.sort((x, y) => (y.value ?? y.cost) - (x.value ?? x.cost));
    const value = a.cash_cents + invested;
    return {
      accountId, season: seasonView({ ...season, players: players[0]!.n, joined: true }), cash: a.cash_cents, reserved: a.reserved_cents, invested, value, realized, unrealized,
      dayPnl: dayKnown ? dayPnl : null, returnBps: returnBps(BigInt(value), BigInt(a.starting_cash_cents)), positions, unpriced,
    };
  }

  async accountFor(userId: string, seasonId: string): Promise<string | null> {
    const [a] = await this.sql<{ id: string }[]>`SELECT id FROM rt_accounts WHERE season_id = ${seasonId} AND user_id = ${userId}`;
    return a?.id ?? null;
  }

  /** Every account's value at current marks (positions without a price count at cost), for boards and snapshots. */
  private async values(seasonId: string | null) {
    const accounts = seasonId
      ? await this.sql<(AccountMark & { season_id: string })[]>`
        SELECT a.id, a.user_id, u.nickname, a.cash_cents, a.starting_cash_cents, a.season_id, coalesce(p.public, false) AS public
        FROM rt_accounts a JOIN users u ON u.id = a.user_id LEFT JOIN rt_profiles p ON p.user_id = a.user_id WHERE a.season_id = ${seasonId}`
      : await this.sql<(AccountMark & { season_id: string })[]>`
        SELECT a.id, a.user_id, u.nickname, a.cash_cents, a.starting_cash_cents, a.season_id, false AS public
        FROM rt_accounts a JOIN rt_seasons s ON s.id = a.season_id JOIN users u ON u.id = a.user_id WHERE s.status = 'active'`;
    const pos = await this.sql<{ account_id: string; instrument_id: number; qty: number; cost_cents: number; realized_cents: number }[]>`
      SELECT p.account_id, p.instrument_id, p.qty, p.cost_cents, p.realized_cents FROM rt_positions p
      WHERE p.account_id = ANY(${accounts.map((a) => a.id)}::uuid[])`;
    const instruments = new Map((await this.catalogue.many([...new Set(pos.map((p) => p.instrument_id))])).map((i) => [i.id, i]));
    const marks = new Map<number, { price: number | null; fx: bigint | null; prev: number | null }>();
    for (const i of instruments.values()) {
      const m = await this.markOf(i);
      marks.set(i.id, { price: m.price, fx: m.fx, prev: m.q?.prevClose ?? null });
    }
    const out = new Map<string, { a: AccountMark & { season_id: string }; value: number; day: number | null; best: { symbol: string; returnBps: number } | null }>();
    for (const a of accounts) out.set(a.id, { a, value: a.cash_cents, day: 0, best: null });
    for (const p of pos) {
      const o = out.get(p.account_id)!;
      const m = marks.get(p.instrument_id);
      const i = instruments.get(p.instrument_id);
      const v = p.qty > 0 && m?.price && m.fx ? Number(markValue(BigInt(p.qty), BigInt(m.price), m.fx)) : null;
      o.value += p.qty > 0 ? (v ?? p.cost_cents) : 0;
      if (p.qty > 0) {
        if (v !== null && m?.prev && m.fx && o.day !== null) o.day += v - Number(markValue(BigInt(p.qty), BigInt(m.prev), m.fx));
        else if (o.day !== null) o.day = null;
      }
      // A pick's return: the open position's unrealised gain over its cost.
      if (i && p.qty > 0 && p.cost_cents > 0 && v !== null) {
        const bps = Math.round(((v - p.cost_cents) * 10_000) / p.cost_cents);
        if (!o.best || bps > o.best.returnBps) o.best = { symbol: i.symbol, returnBps: bps };
      }
    }
    return out;
  }

  async computeBoards() {
    const seasons = await this.sql<{ id: string }[]>`SELECT id FROM rt_seasons WHERE status = 'active'`;
    for (const s of seasons) {
      const prev = new Map((this.boards.get(s.id) ?? []).map((r) => [r.userId, r.rank]));
      const rows = await this.board(s.id, 'value', 100_000, true);
      this.boards.set(s.id, rows);
      for (const r of rows.slice(0, 10)) {
        const was = prev.get(r.userId);
        if (was !== undefined && was > 10) void this.notify(r.userId, 'rank', `You are in the top 10 of the leaderboard: #${r.rank}.`, `rank10:${s.id}:${zoned(this.cfg.now(), this.cfg.tz).date}`);
      }
    }
  }

  async board(seasonId: string, sort: 'value' | 'return' | 'day' | 'pick', limit: number, fresh = false): Promise<(BoardRow & { accountId: string })[]> {
    const cached = !fresh && this.boards.get(seasonId);
    let rows: (BoardRow & { accountId: string })[];
    if (cached) rows = cached as (BoardRow & { accountId: string })[];
    else {
      const v = await this.values(seasonId);
      rows = [...v.values()].map((x) => ({
        rank: 0, accountId: x.a.id, userId: x.a.user_id, nickname: x.a.nickname, value: x.value,
        returnBps: returnBps(BigInt(x.value), BigInt(x.a.starting_cash_cents)), dayPnl: x.day, bestPick: x.best, public: x.a.public,
      }));
      rows.sort((a, b) => b.value - a.value || a.nickname.localeCompare(b.nickname));
      rows.forEach((r, k) => (r.rank = k + 1));
      if (fresh) this.boards.set(seasonId, rows);
    }
    const key = { value: (r: BoardRow) => r.value, return: (r: BoardRow) => r.returnBps, day: (r: BoardRow) => r.dayPnl ?? -Infinity, pick: (r: BoardRow) => r.bestPick?.returnBps ?? -Infinity }[sort];
    const sorted = sort === 'value' ? rows : [...rows].sort((a, b) => key(b) - key(a));
    return sorted.slice(0, limit).map((r, k) => ({ ...r, rank: sort === 'value' ? r.rank : k + 1 }));
  }

  async snapshot() {
    if (!exchangesTrading(this.cfg.now()).length) return;
    const v = await this.values(null);
    const at = new Date(Math.floor(this.cfg.now() / 60_000) * 60_000);
    const rows = [...v.values()].map((x) => ({ account_id: x.a.id, at, value_cents: x.value }));
    for (let k = 0; k < rows.length; k += 1000) {
      await this.sql`INSERT INTO rt_snapshots ${this.sql(rows.slice(k, k + 1000), 'account_id', 'at', 'value_cents')} ON CONFLICT DO NOTHING`;
    }
  }

  async history(accountId: string) {
    return this.sql<{ at: Date; value_cents: number }[]>`SELECT at, value_cents FROM rt_snapshots WHERE account_id = ${accountId} ORDER BY at LIMIT 20000`;
  }

  // ---------------------------------------------------------------- notifications

  async notify(userId: string, kind: string, text: string, dedupe: string | null) {
    const [p] = await this.sql<{ muted: string[] }[]>`SELECT muted FROM rt_profiles WHERE user_id = ${userId}`;
    if (p?.muted.includes(kind)) return;
    const [n] = await this.sql<{ id: number; created_at: Date }[]>`
      INSERT INTO rt_notifications (user_id, kind, text, dedupe) VALUES (${userId}, ${kind}, ${text}, ${dedupe})
      ON CONFLICT (user_id, dedupe) DO NOTHING RETURNING id, created_at`;
    if (n) this.sendTo(userId, { t: 'note', n: { id: n.id, kind, text, read: false, at: n.created_at.getTime() } satisfies Notification });
  }

  /** A watched or held instrument moving 5% on the day tells its followers, once per day and direction. */
  private async watchMoves(qs: { id: number; last: number | null; prevClose: number | null }[]) {
    const big = qs.filter((q) => q.last && q.prevClose && Math.abs(((q.last - q.prevClose) * 10_000) / q.prevClose) >= 500);
    for (const q of big) {
      const bps = Math.round(((q.last! - q.prevClose!) * 10_000) / q.prevClose!);
      const dir = bps > 0 ? 'up' : 'down';
      const key = `${q.id}:${dir}`;
      const day = zoned(this.cfg.now(), 'UTC').date;
      if (this.dayOpen.get(q.id) === Number(day.replaceAll('-', '')) * (bps > 0 ? 1 : -1)) continue;
      this.dayOpen.set(q.id, Number(day.replaceAll('-', '')) * (bps > 0 ? 1 : -1));
      const i = await this.catalogue.get(q.id);
      if (!i) continue;
      const users = await this.sql<{ user_id: string }[]>`
        SELECT user_id FROM rt_watchlist WHERE instrument_id = ${q.id}
        UNION SELECT a.user_id FROM rt_positions p JOIN rt_accounts a ON a.id = p.account_id WHERE p.instrument_id = ${q.id} AND p.qty > 0`;
      for (const u of users) void this.notify(u.user_id, 'move', `${i.symbol} is ${dir} ${(Math.abs(bps) / 100).toFixed(1)}% today.`, `move:${key}:${day}`);
    }
  }

  /** Market open and close for the exchanges a player holds or watches. */
  private async sessionAlerts() {
    const t = this.cfg.now();
    for (const id of Object.keys(EXCHANGES) as ExchangeId[]) {
      const localDate = zoned(t, EXCHANGES[id].tz).date;
      const day = sessionsOn(EXCHANGES[id], localDate);
      if (!day) continue;
      const justOpened = t >= day.open && t - day.open < 120_000;
      const closedNow = t >= day.close && t - day.close < 120_000;
      if (!justOpened && !closedNow) continue;
      const users = await this.sql<{ user_id: string }[]>`
        SELECT DISTINCT w.user_id FROM rt_watchlist w JOIN rt_instruments i ON i.id = w.instrument_id WHERE i.exchange = ${id}
        UNION SELECT DISTINCT a.user_id FROM rt_positions p JOIN rt_accounts a ON a.id = p.account_id JOIN rt_instruments i ON i.id = p.instrument_id
        WHERE i.exchange = ${id} AND p.qty > 0`;
      const what = justOpened ? 'opened' : 'closed';
      for (const u of users) void this.notify(u.user_id, 'session', `${EXCHANGES[id].name} ${what}.`, `session:${id}:${localDate}:${what}`);
    }
  }

  async notifications(userId: string) {
    const rows = await this.sql<{ id: number; kind: string; text: string; read: boolean; created_at: Date }[]>`
      SELECT id, kind, text, read, created_at FROM rt_notifications WHERE user_id = ${userId} ORDER BY id DESC LIMIT 50`;
    return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, read: r.read, at: r.created_at.getTime() }));
  }

  // ---------------------------------------------------------------- jobs

  private async housekeeping() {
    await this.ensureSeasons();
    await this.settleDue();
    await this.sessionAlerts();
  }

  private async loadOverrides() {
    const rows = await this.sql<{ exchange: ExchangeId; day: Date; open_local: string | null; close_local: string | null; source: string }[]>`
      SELECT exchange, day, open_local, close_local, source FROM rt_calendar WHERE day >= current_date - 7`;
    for (const r of rows) setOverride(r.exchange, r.day.toISOString().slice(0, 10), { open: r.open_local, close: r.close_local, source: r.source });
  }

  /** Provider calendars (Alpaca for the US) override the built-in one: holidays, early closes, ad hoc closures. */
  async syncCalendars() {
    const t = this.cfg.now();
    for (const ex of Object.keys(EXCHANGES) as ExchangeId[]) {
      const from = zoned(t, EXCHANGES[ex].tz).date;
      const to = addDays(from, 60);
      const days = await this.feeds.calendar(ex, from, to);
      if (!days?.length) continue;
      const open = new Map(days.map((d) => [d.date, d]));
      const rows: { exchange: string; day: string; open_local: string | null; close_local: string | null; source: string }[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
        const pd = open.get(d);
        if (pd) rows.push({ exchange: ex, day: d, open_local: pd.open, close_local: pd.close, source: 'provider' });
        else if (wd !== 0 && wd !== 6) rows.push({ exchange: ex, day: d, open_local: null, close_local: null, source: 'provider' });
      }
      for (const r of rows) setOverride(ex, r.day, { open: r.open_local, close: r.close_local, source: r.source });
      await this.sql`
        INSERT INTO rt_calendar ${this.sql(rows, 'exchange', 'day', 'open_local', 'close_local', 'source')}
        ON CONFLICT (exchange, day) DO UPDATE SET open_local = EXCLUDED.open_local, close_local = EXCLUDED.close_local, source = EXCLUDED.source`;
    }
  }

  /** Splits, dividends and symbol changes for held instruments, applied on their ex-date. */
  async corporateActions() {
    const held = await this.catalogue.many(
      (await this.sql<{ instrument_id: number }[]>`SELECT DISTINCT instrument_id FROM rt_positions WHERE qty > 0`).map((r) => r.instrument_id),
    );
    const today = zoned(this.cfg.now(), 'America/New_York').date;
    if (held.length) {
      const found = (await this.feeds.corporateActions(held, addDays(today, -7), addDays(today, 30))) ?? [];
      const bySym = new Map(held.map((i) => [i.symbol, i]));
      for (const a of found) {
        const i = bySym.get(a.symbol);
        if (!i) continue;
        await this.sql`
          INSERT INTO rt_corporate_actions (instrument_id, kind, ex_date, ratio_from, ratio_to, cash_amount, new_symbol, source)
          VALUES (${i.id}, ${a.kind}, ${a.exDate}, ${a.ratioFrom ?? null}, ${a.ratioTo ?? null}, ${a.cashAmount ?? null}, ${a.newSymbol ?? null}, 'provider')
          ON CONFLICT (instrument_id, kind, ex_date) DO NOTHING`;
      }
    }
    await this.applyDueActions(today);
  }

  async applyDueActions(today: string) {
    const due = await this.sql<{ id: number; instrument_id: number; kind: string; ratio_from: number | null; ratio_to: number | null; cash_amount: number | null; new_symbol: string | null }[]>`
      SELECT id, instrument_id, kind, ratio_from, ratio_to, cash_amount, new_symbol FROM rt_corporate_actions WHERE applied_at IS NULL AND ex_date <= ${today} ORDER BY ex_date, id`;
    for (const a of due) {
      if (a.kind === 'split' && a.ratio_from && a.ratio_to) await this.trading.applySplit(a.id, a.instrument_id, a.ratio_from, a.ratio_to);
      else if (a.kind === 'dividend' && a.cash_amount) await this.trading.applyDividend(a.id, a.instrument_id, a.cash_amount);
      else if (a.kind === 'symbol_change' && a.new_symbol) {
        await this.sql`UPDATE rt_instruments SET symbol = ${a.new_symbol}, updated_at = now() WHERE id = ${a.instrument_id}
          AND NOT EXISTS (SELECT 1 FROM rt_instruments x WHERE x.mic = rt_instruments.mic AND x.symbol = ${a.new_symbol})`;
        await this.sql`UPDATE rt_corporate_actions SET applied_at = now() WHERE id = ${a.id}`;
      } else if (a.kind === 'delisting') {
        await this.sql`UPDATE rt_instruments SET status = 'delisted' WHERE id = ${a.instrument_id}`;
        await this.trading.cancelInstrument(a.instrument_id, 'The listing ended');
        await this.sql`UPDATE rt_corporate_actions SET applied_at = now() WHERE id = ${a.id}`;
      }
      this.catalogue.forget(a.instrument_id);
    }
  }

  // ---------------------------------------------------------------- player queries

  async ordersOf(userId: string, seasonId: string) {
    const rows = await this.sql`
      SELECT o.* FROM rt_orders o JOIN rt_accounts a ON a.id = o.account_id
      WHERE a.user_id = ${userId} AND a.season_id = ${seasonId} ORDER BY o.created_at DESC LIMIT 200`;
    const instruments = new Map((await this.catalogue.many([...new Set(rows.map((r) => r.instrument_id as number))])).map((i) => [i.id, i]));
    return rows.flatMap((r) => (instruments.has(r.instrument_id) ? [this.trading.view(r as never, instruments.get(r.instrument_id)!)] : []));
  }

  async executionsOf(userId: string, seasonId: string): Promise<Execution[]> {
    const rows = await this.sql<{ id: number; order_id: string; instrument_id: number; symbol: string; name: string; currency: string; side: 'buy' | 'sell'; qty: number; price: number;
      fx_per_eur: string; total_cents: number; realized_cents: number; quote_at: Date; quality: Execution['quality']; basis: string; executed_at: Date }[]>`
      SELECT e.id, e.order_id, e.instrument_id, i.symbol, i.name, e.currency, e.side, e.qty, e.price, e.fx_per_eur::text, e.total_cents, e.realized_cents,
        e.quote_at, e.quality, e.basis, e.executed_at
      FROM rt_executions e JOIN rt_accounts a ON a.id = e.account_id JOIN rt_instruments i ON i.id = e.instrument_id
      WHERE a.user_id = ${userId} AND a.season_id = ${seasonId} ORDER BY e.executed_at DESC LIMIT 500`;
    return rows.map((e) => ({
      id: e.id, orderId: e.order_id, instrument: { id: e.instrument_id, symbol: e.symbol, name: e.name, currency: e.currency }, side: e.side, qty: e.qty, price: e.price,
      fxPerEur: e.fx_per_eur, total: e.total_cents, realized: e.realized_cents, quoteAt: e.quote_at.getTime(), quality: e.quality, basis: e.basis, at: e.executed_at.getTime(),
    }));
  }

  async ledgerOf(userId: string, seasonId: string) {
    const rows = await this.sql<{ id: number; kind: LedgerEntry['kind']; amount_cents: number; balance_after_cents: number; note: string | null; created_at: Date }[]>`
      SELECT l.id, l.kind, l.amount_cents, l.balance_after_cents, l.note, l.created_at FROM rt_ledger l JOIN rt_accounts a ON a.id = l.account_id
      WHERE a.user_id = ${userId} AND a.season_id = ${seasonId} ORDER BY l.id DESC LIMIT 500`;
    return rows.map((l): LedgerEntry => ({ id: l.id, kind: l.kind, amount: l.amount_cents, balanceAfter: l.balance_after_cents, note: l.note, at: l.created_at.getTime() }));
  }

  async watchlist(userId: string): Promise<number[]> {
    const rows = await this.sql<{ instrument_id: number }[]>`SELECT instrument_id FROM rt_watchlist WHERE user_id = ${userId} ORDER BY added_at`;
    return rows.map((r) => r.instrument_id);
  }
  async watch(userId: string, id: number, on: boolean) {
    if (on) {
      const [n] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rt_watchlist WHERE user_id = ${userId}`;
      if (n!.n < 200) await this.sql`INSERT INTO rt_watchlist (user_id, instrument_id) VALUES (${userId}, ${id}) ON CONFLICT DO NOTHING`;
    } else await this.sql`DELETE FROM rt_watchlist WHERE user_id = ${userId} AND instrument_id = ${id}`;
    return this.watchlist(userId);
  }

  async results(seasonId: string) {
    const rows = await this.sql<{ rank: number; account_id: string; user_id: string; nickname: string; final_value_cents: number; return_bps: number; best_pick: BoardRow['bestPick']; public: boolean }[]>`
      SELECT r.rank, r.account_id, a.user_id, u.nickname, r.final_value_cents, r.return_bps, r.best_pick, coalesce(p.public, false) AS public
      FROM rt_season_results r JOIN rt_accounts a ON a.id = r.account_id JOIN users u ON u.id = a.user_id LEFT JOIN rt_profiles p ON p.user_id = a.user_id
      WHERE r.season_id = ${seasonId} ORDER BY r.rank LIMIT 100`;
    return rows.map((r) => ({ rank: r.rank, accountId: r.account_id, userId: r.user_id, nickname: r.nickname, value: r.final_value_cents, returnBps: r.return_bps, dayPnl: null, bestPick: r.best_pick, public: r.public }));
  }

  async profile(userId: string) {
    const [p] = await this.sql<{ public: boolean; muted: string[] }[]>`SELECT public, muted FROM rt_profiles WHERE user_id = ${userId}`;
    return { public: p?.public ?? false, muted: p?.muted ?? [] };
  }
  async setProfile(userId: string, pub: boolean, muted: string[]) {
    await this.sql`
      INSERT INTO rt_profiles (user_id, public, muted) VALUES (${userId}, ${pub}, ${muted})
      ON CONFLICT (user_id) DO UPDATE SET public = EXCLUDED.public, muted = EXCLUDED.muted`;
    return this.profile(userId);
  }

  async following(userId: string) {
    return (await this.sql<{ followee_id: string }[]>`SELECT followee_id FROM rt_follows WHERE follower_id = ${userId}`).map((r) => r.followee_id);
  }
  async follow(userId: string, other: string, on: boolean) {
    if (on) await this.sql`INSERT INTO rt_follows (follower_id, followee_id) SELECT ${userId}, id FROM users WHERE id = ${other} ON CONFLICT DO NOTHING`;
    else await this.sql`DELETE FROM rt_follows WHERE follower_id = ${userId} AND followee_id = ${other}`;
  }

  /**
   * Another player's standing; holdings and trades only when their profile is public (or it is you).
   * Private players still show on the leaderboard with their value, never with what they hold.
   */
  async player(userId: string, seasonId: string, viewer: string | null) {
    const [u] = await this.sql<{ id: string; nickname: string; public: boolean }[]>`
      SELECT u.id, u.nickname, coalesce(p.public, false) AS public FROM users u LEFT JOIN rt_profiles p ON p.user_id = u.id WHERE u.id = ${userId}`;
    if (!u) return null;
    const account = await this.accountFor(userId, seasonId);
    const visible = u.public || viewer === userId;
    const portfolio = account ? await this.portfolio(account) : null;
    const [f] = await this.sql<{ followers: number; following: boolean }[]>`
      SELECT (SELECT count(*)::int FROM rt_follows WHERE followee_id = ${userId}) AS followers,
        EXISTS (SELECT 1 FROM rt_follows WHERE follower_id = ${viewer} AND followee_id = ${userId}) AS following`;
    return {
      userId: u.id, nickname: u.nickname, public: u.public, followers: f!.followers, following: f!.following,
      summary: portfolio && { value: portfolio.value, returnBps: portfolio.returnBps, dayPnl: portfolio.dayPnl, startingCash: portfolio.season.startingCash },
      positions: visible ? (portfolio?.positions ?? []) : null,
      trades: visible ? (await this.executionsOf(userId, seasonId)).slice(0, 30) : null,
      history: account ? (await this.history(account)).map((p) => [p.at.getTime(), p.value_cents]) : [],
    };
  }

  /** Recent fills of public players, for the activity feed. */
  async activity(): Promise<Activity[]> {
    const rows = await this.sql<{ nickname: string; user_id: string; side: 'buy' | 'sell'; symbol: string; instrument_id: number; qty: number; price: number; currency: string; executed_at: Date }[]>`
      SELECT u.nickname, a.user_id, e.side, i.symbol, e.instrument_id, e.qty, e.price, e.currency, e.executed_at
      FROM rt_executions e JOIN rt_accounts a ON a.id = e.account_id JOIN users u ON u.id = a.user_id JOIN rt_profiles p ON p.user_id = a.user_id AND p.public
      JOIN rt_instruments i ON i.id = e.instrument_id ORDER BY e.executed_at DESC LIMIT 40`;
    return rows.map((r) => ({ nickname: r.nickname, userId: r.user_id, side: r.side, symbol: r.symbol, instrumentId: r.instrument_id, qty: r.qty, price: r.price, currency: r.currency, at: r.executed_at.getTime() }));
  }

  async markRead(userId: string) {
    await this.sql`UPDATE rt_notifications SET read = true WHERE user_id = ${userId} AND NOT read`;
  }

  // ---------------------------------------------------------------- research

  async newsFor(ids: number[]) {
    const key = ids.join(',');
    const hit = this.news.get(key);
    if (hit && this.cfg.now() - hit.at < 5 * 60_000) return hit.items;
    const list = await this.catalogue.many(ids);
    const items = (await this.feeds.news(list, 20)) ?? [];
    if (this.news.size > 500) this.news.clear();
    this.news.set(key, { at: this.cfg.now(), items });
    return items;
  }

  /** Top movers from the provider's screener when it has one, else among instruments priced here (and labelled so). */
  async movers() {
    if (this.moversCache && this.cfg.now() - this.moversCache.at < 60_000) return this.moversCache.value;
    const m = await this.feeds.movers();
    let value: { source: 'provider' | 'priced'; gainers: number[]; losers: number[]; actives: number[] };
    if (m) {
      const want = [...new Set([...m.gainers, ...m.losers, ...m.actives])];
      const rows = want.length ? await this.sql<{ id: number; symbol: string }[]>`
        SELECT id, symbol FROM rt_instruments WHERE exchange = 'US' AND symbol = ANY(${want}::text[]) AND status = 'active'` : [];
      const id = new Map(rows.map((r) => [r.symbol, Number(r.id)]));
      const map = (l: string[]) => l.flatMap((s) => id.get(s) ?? []);
      value = { source: 'provider', gainers: map(m.gainers), losers: map(m.losers), actives: map(m.actives) };
    } else {
      const indices = new Set((await this.catalogue.many([...this.market.quotes.keys()])).filter((i) => i.kind === 'index').map((i) => i.id));
      const qs = [...this.market.quotes.values()].filter((q) => q.last && q.prevClose && !indices.has(q.id));
      const ch = (q: (typeof qs)[number]) => (q.last! - q.prevClose!) / q.prevClose!;
      const sorted = [...qs].sort((a, b) => ch(b) - ch(a));
      value = {
        source: 'priced', gainers: sorted.filter((q) => ch(q) > 0).slice(0, 15).map((q) => q.id), losers: sorted.filter((q) => ch(q) < 0).reverse().slice(0, 15).map((q) => q.id),
        actives: [...qs].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, 15).map((q) => q.id),
      };
    }
    this.moversCache = { at: this.cfg.now(), value };
    return value;
  }
}

function seasonView(s: SeasonRow & { players: number; joined: boolean }): Season {
  return {
    id: s.id, slug: s.slug, name: s.name, kind: s.kind, startingCash: s.starting_cash_cents, startsAt: s.starts_at.getTime(), endsAt: s.ends_at?.getTime() ?? null,
    joinUntil: s.join_until?.getTime() ?? null, rules: s.rules, status: s.status, players: s.players, joined: s.joined,
  };
}

const fmtQty = (micro: number) => (micro % 1_000_000 === 0 ? String(micro / 1_000_000) : (micro / 1_000_000).toFixed(6).replace(/0+$/, ''));
