import type { Sql } from '../db/db.js';
import type { Asset } from '../market/assets.js';
import type { Category, Figure, ScheduledEvent, Scope } from '../market/events.js';
import { sharesOf, type Report } from '../market/fundamentals.js';
import type { MarketState } from '../market/sim.js';
import type { EventInfo, PlayerResult, Results, TradeInfo } from '../protocol.js';
import type { Fill, Position } from '../trading/portfolio.js';

export interface SessionRow {
  id: string;
  /** Room code; null for the house competition that loops by itself. */
  code: string | null;
  name: string | null;
  description: string | null;
  host_user_id: string | null;
  visibility: 'public' | 'private';
  awards: Results['awards'] | null;
  seed: number;
  start_seq: number | null;
  opening_prices: Record<string, number> | null;
  status: 'lobby' | 'trading' | 'finished';
  config: SessionConfig;
  opens_at: Date;
  closes_at: Date;
  finished_at: Date | null;
}

export interface SessionConfig {
  tickMs: number;
  totalTicks: number;
  closingSeconds: number;
  resultsSeconds: number;
  maxPlayers: number;
  /** The purse every player of this competition starts with, in cents. */
  startingCash: number;
  /** Custom rooms only: the bell waits for the host (opens_at is then the lobby's expiry). */
  manualStart?: boolean;
  /** Players may join after the bell. Missing = true, as in the house competition. */
  lateJoin?: boolean;
  /** Participants may inspect each other's portfolios while trading. Missing = false. */
  peek?: boolean;
  /** Every portfolio is shown on the results page. Missing = true. */
  reveal?: boolean;
  /** A private room's results are visible to people outside it. Missing = false. */
  publicResults?: boolean;
}

const COLS = 'id, code, name, description, host_user_id, visibility, awards, seed, status, config, opens_at, closes_at, finished_at, start_seq, opening_prices';

export async function upsertAssets(sql: Sql, assets: Asset[]) {
  for (const a of assets) {
    await sql`
      INSERT INTO assets (ticker, name, exchange, sector, industry, description, base_price_cents, volatility, beta, sensitivities, shares_m)
      VALUES (${a.ticker}, ${a.name}, ${a.exchange}, ${a.sector}, ${a.industry}, ${a.description}, ${a.base}, ${a.vol}, ${a.beta}, ${sql.json(a.sens)}, ${sharesOf(a)})
      ON CONFLICT (ticker) DO UPDATE SET name = excluded.name, exchange = excluded.exchange, sector = excluded.sector,
        industry = excluded.industry, description = excluded.description, base_price_cents = excluded.base_price_cents,
        volatility = excluded.volatility, beta = excluded.beta, sensitivities = excluded.sensitivities, shares_m = excluded.shares_m`;
  }
}

export async function liveSessions(sql: Sql): Promise<SessionRow[]> {
  return sql<SessionRow[]>`SELECT ${sql.unsafe(COLS)} FROM sessions WHERE status <> 'finished' ORDER BY created_at`;
}

/** Any competition by room code, live or finished. */
export async function sessionByCode(sql: Sql, code: string): Promise<SessionRow | null> {
  const [row] = await sql<SessionRow[]>`SELECT ${sql.unsafe(COLS)} FROM sessions WHERE code = ${code}`;
  return row ?? null;
}

export async function sessionById(sql: Sql, id: string): Promise<SessionRow | null> {
  const [row] = await sql<SessionRow[]>`SELECT ${sql.unsafe(COLS)} FROM sessions WHERE id = ${id}`;
  return row ?? null;
}

export interface RoomFields {
  code: string;
  name: string;
  description: string | null;
  hostUserId: string;
  visibility: 'public' | 'private';
}

export async function createSession(sql: Sql, seed: number, opensAt: Date, closesAt: Date, config: SessionConfig, room?: RoomFields): Promise<SessionRow> {
  const [row] = await sql<SessionRow[]>`
    INSERT INTO sessions (seed, status, config, opens_at, closes_at, code, name, description, host_user_id, visibility)
    VALUES (${seed}, 'lobby', ${sql.json({ ...config })}, ${opensAt}, ${closesAt}, ${room?.code ?? null}, ${room?.name ?? null},
      ${room?.description ?? null}, ${room?.hostUserId ?? null}, ${room?.visibility ?? 'public'})
    RETURNING ${sql.unsafe(COLS)}`;
  return row!;
}

/** A room whose host never rang the bell: closed with no results. */
export async function abandonSession(sql: Sql, id: string) {
  await sql`UPDATE sessions SET status = 'finished', finished_at = now() WHERE id = ${id} AND status = 'lobby'`;
}

export async function participantId(sql: Sql, sessionId: string, userId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM participants WHERE session_id = ${sessionId} AND user_id = ${userId}`;
  return row?.id ?? null;
}

/** Every price at one market sequence number: a competition's close when the market has since moved on. */
export async function pricesAt(sql: Sql, seq: number): Promise<Record<string, number>> {
  const rows = await sql<{ ticker: string; price_cents: number }[]>`SELECT ticker, price_cents FROM market_prices WHERE seq = ${seq}`;
  return Object.fromEntries(rows.map((r) => [r.ticker, r.price_cents]));
}

export async function setSessionTimes(sql: Sql, id: string, opensAt: Date, closesAt: Date) {
  await sql`UPDATE sessions SET opens_at = ${opensAt}, closes_at = ${closesAt} WHERE id = ${id} AND status = 'lobby'`;
}

/** The host rang the bell: the room opens now and no longer waits for a manual start. */
export async function startNow(sql: Sql, id: string, opensAt: Date, closesAt: Date) {
  await sql`
    UPDATE sessions SET opens_at = ${opensAt}, closes_at = ${closesAt}, config = config || '{"manualStart": false}'::jsonb
    WHERE id = ${id} AND status = 'lobby'`;
}

export async function setCloseTime(sql: Sql, id: string, closesAt: Date) {
  await sql`UPDATE sessions SET closes_at = ${closesAt} WHERE id = ${id} AND status = 'trading'`;
}


export interface LoadedParticipant {
  id: string;
  userId: string;
  nickname: string;
  cash: number;
  joinedAt: Date;
  trades: number;
  positions: Map<string, Position>;
}

export async function loadParticipants(sql: Sql, sessionId: string): Promise<LoadedParticipant[]> {
  const rows = await sql<{ id: string; user_id: string; nickname: string; cash_cents: number; joined_at: Date; trades: number }[]>`
    SELECT p.id, p.user_id, u.nickname, p.cash_cents, p.joined_at,
      (SELECT count(*)::int FROM trades t WHERE t.participant_id = p.id) AS trades
    FROM participants p JOIN users u ON u.id = p.user_id WHERE p.session_id = ${sessionId}`;
  const positions = await sql<{ participant_id: string; ticker: string; quantity: number; cost_cents: number; realized_cents: number }[]>`
    SELECT pos.* FROM positions pos JOIN participants p ON p.id = pos.participant_id WHERE p.session_id = ${sessionId}`;
  const byId = new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, userId: r.user_id, nickname: r.nickname, cash: r.cash_cents, joinedAt: r.joined_at, trades: r.trades, positions: new Map<string, Position>() },
    ]),
  );
  for (const p of positions) byId.get(p.participant_id)?.positions.set(p.ticker, { qty: p.quantity, cost: p.cost_cents, realized: p.realized_cents });
  return [...byId.values()];
}

/** Creates the participant and books the opening grant, or returns the existing one. */
export async function joinSession(sql: Sql, sessionId: string, userId: string, startingCash: number): Promise<{ id: string; joinedAt: Date; created: boolean }> {
  return sql.begin(async (tx) => {
    const [p] = await tx<{ id: string; joined_at: Date }[]>`
      INSERT INTO participants (session_id, user_id, cash_cents) VALUES (${sessionId}, ${userId}, ${startingCash})
      ON CONFLICT (session_id, user_id) DO NOTHING RETURNING id, joined_at`;
    if (!p) {
      const [existing] = await tx<{ id: string; joined_at: Date }[]>`
        SELECT id, joined_at FROM participants WHERE session_id = ${sessionId} AND user_id = ${userId}`;
      return { id: existing!.id, joinedAt: existing!.joined_at, created: false };
    }
    await tx`INSERT INTO ledger (participant_id, kind, amount_cents, balance_after_cents) VALUES (${p.id}, 'grant', ${startingCash}, ${startingCash})`;
    return { id: p.id, joinedAt: p.joined_at, created: true };
  });
}

export class DuplicateOrder extends Error {}

/**
 * Books one fill atomically: trade row, cash, position, ledger. The unique (participant, client order id)
 * makes a replayed order a no-op, and the CHECK constraints refuse negative cash or shares even if the
 * in-memory mirror were ever wrong. The returned balances are compared with the mirror by the caller.
 */
export async function recordFill(sql: Sql, participantId: string, clientOrderId: string, fill: Fill, tick: number) {
  return sql.begin(async (tx) => {
    const [trade] = await tx<{ id: number }[]>`
      INSERT INTO trades (participant_id, client_order_id, ticker, side, quantity, price_cents, total_cents, realized_cents, tick)
      VALUES (${participantId}, ${clientOrderId}, ${fill.ticker}, ${fill.side}, ${fill.qty}, ${fill.price}, ${fill.total}, ${fill.realized}, ${tick})
      ON CONFLICT (participant_id, client_order_id) DO NOTHING RETURNING id`;
    if (!trade) throw new DuplicateOrder();

    const cashDelta = fill.side === 'buy' ? -fill.total : fill.total;
    const [p] = await tx<{ cash_cents: number }[]>`
      UPDATE participants SET cash_cents = cash_cents + ${cashDelta} WHERE id = ${participantId} RETURNING cash_cents`;
    const qtyDelta = fill.side === 'buy' ? fill.qty : -fill.qty;
    const [pos] = await tx<{ quantity: number; cost_cents: number; realized_cents: number }[]>`
      INSERT INTO positions (participant_id, ticker, quantity, cost_cents, realized_cents)
      VALUES (${participantId}, ${fill.ticker}, ${fill.position.qty}, ${fill.position.cost}, ${fill.position.realized})
      ON CONFLICT (participant_id, ticker) DO UPDATE SET
        quantity = positions.quantity + ${qtyDelta},
        cost_cents = ${fill.position.cost},
        realized_cents = positions.realized_cents + ${fill.realized}
      RETURNING quantity, cost_cents, realized_cents`;
    if (p!.cash_cents !== fill.cashAfter || pos!.quantity !== fill.position.qty || pos!.realized_cents !== fill.position.realized) {
      throw new Error(`book mismatch for participant ${participantId}: db cash ${p!.cash_cents} qty ${pos!.quantity}, expected ${fill.cashAfter} ${fill.position.qty}`);
    }
    await tx`
      INSERT INTO ledger (participant_id, kind, trade_id, amount_cents, balance_after_cents)
      VALUES (${participantId}, ${fill.side}, ${trade.id}, ${cashDelta}, ${p!.cash_cents})`;
    return trade.id;
  });
}

export async function recordSnapshot(sql: Sql, sessionId: string, tick: number, ranking: unknown) {
  await sql`INSERT INTO leaderboard_snapshots (session_id, tick, ranking) VALUES (${sessionId}, ${tick}, ${sql.json(ranking as never)}) ON CONFLICT DO NOTHING`;
}

export async function finishSession(sql: Sql, sessionId: string, closing: Record<string, number>, results: PlayerResult[], awards: Results['awards']) {
  await sql.begin(async (tx) => {
    for (const r of results) {
      await tx`
        INSERT INTO results (session_id, participant_id, rank, final_value_cents, return_bps, stats)
        VALUES (${sessionId}, ${r.participantId}, ${r.rank}, ${r.value}, ${r.bps}, ${tx.json(r as never)})
        ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE sessions SET status = 'finished', finished_at = now(), closing_prices = ${tx.json(closing)}, awards = ${tx.json(awards as never)} WHERE id = ${sessionId}`;
  });
}

export async function resultFor(sql: Sql, participantId: string): Promise<PlayerResult | null> {
  const [row] = await sql<{ stats: PlayerResult }[]>`SELECT stats FROM results WHERE participant_id = ${participantId}`;
  return row?.stats ?? null;
}

export async function resultForUser(sql: Sql, sessionId: string, userId: string): Promise<PlayerResult | null> {
  const [row] = await sql<{ stats: PlayerResult }[]>`
    SELECT r.stats FROM results r JOIN participants p ON p.id = r.participant_id WHERE r.session_id = ${sessionId} AND p.user_id = ${userId}`;
  return row?.stats ?? null;
}

export async function sessionResults(sql: Sql, sessionId: string, limit: number): Promise<PlayerResult[]> {
  const rows = await sql<{ stats: PlayerResult }[]>`SELECT stats FROM results WHERE session_id = ${sessionId} ORDER BY rank LIMIT ${limit}`;
  return rows.map((r) => r.stats);
}

// ---------------------------------------------------------------- the persistent market

/** Inserts reports that are not stored yet; existing periods are never rewritten. */
export async function insertReports(sql: Sql, reports: Report[], eventId: number | null = null) {
  if (!reports.length) return;
  const col = <K extends keyof Report>(k: K) => reports.map((r) => r[k]);
  await sql`
    INSERT INTO financial_reports (ticker, fiscal_year, fiscal_quarter, period_end, reported_at, revenue_m, net_income_m, eps, eps_estimate, source, event_id)
    SELECT t.*, ${eventId}::bigint FROM unnest(
      ${col('ticker')}::text[], ${col('fiscalYear')}::int[], ${col('fiscalQuarter')}::int[], ${col('periodEnd')}::date[],
      ${col('reportedAt').map((ms) => new Date(ms).toISOString())}::timestamptz[], ${col('revenue')}::float8[], ${col('netIncome')}::float8[],
      ${col('eps')}::float8[], ${col('epsEstimate') as number[]}::float8[], ${col('source')}::text[]) AS t
    ON CONFLICT DO NOTHING`;
}

export async function loadReports(sql: Sql): Promise<Report[]> {
  const rows = await sql<{ ticker: string; fiscal_year: number; fiscal_quarter: number; period_end: Date; reported_at: Date; revenue_m: number; net_income_m: number; eps: number; eps_estimate: number | null; source: 'simulated' }[]>`
    SELECT ticker, fiscal_year, fiscal_quarter, period_end, reported_at, revenue_m, net_income_m, eps, eps_estimate, source
    FROM financial_reports ORDER BY ticker, fiscal_year, fiscal_quarter`;
  return rows.map((r) => ({
    ticker: r.ticker, fiscalYear: r.fiscal_year, fiscalQuarter: r.fiscal_quarter, periodEnd: r.period_end.toISOString().slice(0, 10),
    reportedAt: r.reported_at.getTime(), revenue: r.revenue_m, netIncome: r.net_income_m, eps: r.eps, epsEstimate: r.eps_estimate, source: r.source,
  }));
}

export async function latestCheckpoint(sql: Sql): Promise<MarketState | null> {
  const [row] = await sql<{ state: MarketState }[]>`SELECT state FROM market_checkpoints ORDER BY seq DESC LIMIT 1`;
  return row?.state ?? null;
}

/** Closing prices of the last competition played before the market became persistent, if any. */
export async function legacyClosingPrices(sql: Sql): Promise<Record<string, number>> {
  const [row] = await sql<{ closing_prices: Record<string, number> }[]>`
    SELECT closing_prices FROM sessions WHERE status = 'finished' AND closing_prices IS NOT NULL ORDER BY finished_at DESC LIMIT 1`;
  return row?.closing_prices ?? {};
}

/** Writes the genesis checkpoint once. A second process racing it inserts nothing. */
export async function initMarket(sql: Sql, state: MarketState) {
  await sql`INSERT INTO market_checkpoints (seq, state) VALUES (${state.seq}, ${sql.json(state as never)}) ON CONFLICT DO NOTHING`;
}

export interface StoredEvent extends ScheduledEvent {
  id: number;
  seq: number;
  sessionId: string;
  status: 'scheduled' | 'published' | 'cancelled';
  publishedAt: number | null;
}

/**
 * The bell: stores the competition's whole schedule (unpublished) and its opening prices in one
 * transaction with the status change. Running it again after a lost reply opens nothing twice: the
 * events already stored come back instead.
 */
export async function openSession(
  sql: Sql, sessionId: string, startSeq: number, openingPrices: Record<string, number>, events: ScheduledEvent[], assets: Asset[],
  opensAt: Date, closesAt: Date,
): Promise<{ startSeq: number; events: StoredEvent[] }> {
  return sql.begin(async (tx) => {
    const [opened] = await tx<{ start_seq: number }[]>`
      UPDATE sessions SET status = 'trading', start_seq = ${startSeq}, opening_prices = ${tx.json(openingPrices)}, opens_at = ${opensAt}, closes_at = ${closesAt}
      WHERE id = ${sessionId} AND status = 'lobby' RETURNING start_seq`;
    if (opened) {
      for (const ev of events) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO market_events (session_id, seq, template, headline, description, severity, scope, target, tick, duration,
            category, related, figures, jump, persistence, report, market_seq, status)
          VALUES (${sessionId}, ${ev.ord}, ${ev.template}, ${ev.headline}, ${ev.body}, ${ev.severity}, ${ev.scope}, ${ev.target}, ${ev.tick}, ${ev.duration},
            ${ev.category}, ${ev.related}, ${tx.json(ev.figures as never)}, ${ev.jump}, ${ev.persistence}, ${ev.report ? tx.json(ev.report as never) : null},
            ${startSeq + ev.tick}, 'scheduled')
          RETURNING id`;
        if (ev.effects.length) {
          await tx`
            INSERT INTO market_event_effects (event_id, ticker, impact_bps, pct)
            SELECT ${row!.id}, * FROM unnest(${ev.effects.map((e) => assets[e.asset]!.ticker)}::text[],
              ${ev.effects.map((e) => Math.round(e.pct * 10_000))}::int[], ${ev.effects.map((e) => e.pct)}::float8[])`;
        }
      }
    }
    const [s] = await tx<{ start_seq: number }[]>`SELECT start_seq FROM sessions WHERE id = ${sessionId}`;
    return { startSeq: Number(s!.start_seq), events: await eventsWhere(tx as unknown as Sql, tx`e.session_id = ${sessionId}`, assets) };
  });
}

/** Every event that can still move a price after `seq`: not yet landed, or still drifting in. */
export async function liveEvents(sql: Sql, seq: number, assets: Asset[]): Promise<StoredEvent[]> {
  return eventsWhere(sql, sql`e.status <> 'cancelled' AND e.market_seq IS NOT NULL AND e.market_seq + e.duration > ${seq}`, assets);
}

async function eventsWhere(sql: Sql, where: ReturnType<Sql>, assets: Asset[]): Promise<StoredEvent[]> {
  const index = new Map(assets.map((a, i) => [a.ticker, i]));
  const rows = await sql<{
    id: number; session_id: string; seq: number; template: string; category: Category; scope: Scope; target: string | null; related: string[];
    headline: string; description: string; figures: Figure[]; severity: 1 | 2 | 3; tick: number; duration: number; jump: number; persistence: number;
    report: Report | null; market_seq: number; status: StoredEvent['status']; published_at: Date | null; effects: { ticker: string; pct: number }[];
  }[]>`
    SELECT e.*, coalesce((SELECT json_agg(json_build_object('ticker', f.ticker, 'pct', coalesce(f.pct, f.impact_bps / 10000.0)))
      FROM market_event_effects f WHERE f.event_id = e.id), '[]') AS effects
    FROM market_events e WHERE ${where} ORDER BY e.market_seq, e.id`;
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id, seq: r.market_seq, ord: r.seq, tick: r.tick, template: r.template, category: r.category, scope: r.scope,
    target: r.target, related: r.related, headline: r.headline, body: r.description, figures: r.figures, severity: r.severity,
    duration: r.duration, jump: r.jump, persistence: r.persistence, report: r.report, status: r.status,
    publishedAt: r.published_at?.getTime() ?? null,
    // A company delisted from the code since the event was stored simply stops being moved by it.
    effects: r.effects.flatMap((e) => (index.has(e.ticker) ? [{ asset: index.get(e.ticker)!, pct: e.pct }] : [])),
  }));
}

/** The latest published news across every competition, newest first. */
export async function recentNews(sql: Sql, limit: number): Promise<EventInfo[]> {
  const rows = await sql<{ id: number; session_id: string; market_seq: number | null; category: Category; scope: Scope; target: string | null; related: string[]; headline: string; description: string; figures: Figure[]; severity: 1 | 2 | 3; published_at: Date }[]>`
    SELECT id, session_id, market_seq, category, scope, target, related, headline, description, figures, severity, published_at
    FROM market_events WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id, seq: r.market_seq ?? 0, at: r.published_at.getTime(), category: r.category, scope: r.scope,
    target: r.target, related: r.related, headline: r.headline, body: r.description, figures: r.figures, severity: r.severity,
  }));
}

export class CheckpointConflict extends Error {}

export interface Checkpoint {
  prevSeq: number;
  state: MarketState;
  prices: { ticker: string; seq: number; at: number; sessionId: string | null; price: number }[];
  published: { id: number; at: number }[];
  cancelled: number[];
  reports: { report: Report; eventId: number }[];
}

/**
 * One atomic step of the durable market: the new state, the prices that led to it, the news that
 * landed and the reports it filed. It only applies on top of the checkpoint it was built from, so a
 * second writer, or a writer that fell behind, fails loudly instead of forking the market.
 */
export async function writeCheckpoint(sql: Sql, c: Checkpoint) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4372)`;
    const [head] = await tx<{ seq: number | null }[]>`SELECT max(seq) AS seq FROM market_checkpoints`;
    if (head!.seq !== c.prevSeq) throw new CheckpointConflict(`market head is ${head!.seq}, this writer built on ${c.prevSeq}`);
    if (c.prices.length) {
      await tx`
        INSERT INTO market_prices (ticker, seq, at, session_id, price_cents)
        SELECT * FROM unnest(${c.prices.map((p) => p.ticker)}::text[], ${c.prices.map((p) => p.seq)}::bigint[],
          ${c.prices.map((p) => new Date(p.at).toISOString())}::timestamptz[], ${c.prices.map((p) => p.sessionId) as string[]}::uuid[],
          ${c.prices.map((p) => p.price)}::int[])
        ON CONFLICT DO NOTHING`;
    }
    for (const p of c.published) {
      await tx`UPDATE market_events SET status = 'published', published_at = ${new Date(p.at)} WHERE id = ${p.id} AND status = 'scheduled'`;
    }
    if (c.cancelled.length) await tx`UPDATE market_events SET status = 'cancelled' WHERE id = ANY(${c.cancelled}) AND status = 'scheduled'`;
    for (const r of c.reports) await insertReports(tx as unknown as Sql, [r.report], r.eventId);
    await tx`INSERT INTO market_checkpoints (seq, state) VALUES (${c.state.seq}, ${tx.json(c.state as never)}) ON CONFLICT DO NOTHING`;
  });
}

export interface PricePoint {
  /** Bucket start, epoch ms. */
  at: number;
  o: number;
  h: number;
  l: number;
  c: number;
  seq: number;
}

/** Stored prices for one company since `from`, one OHLC bar per bucket. */
export async function priceBars(sql: Sql, ticker: string, from: Date, bucketMs: number): Promise<PricePoint[]> {
  const rows = await sql<{ t: Date; o: number; h: number; l: number; c: number; seq: number }[]>`
    SELECT date_bin(make_interval(secs => ${bucketMs / 1000}), at, timestamptz 'epoch') AS t,
      (array_agg(price_cents ORDER BY seq))[1] AS o, max(price_cents) AS h, min(price_cents) AS l,
      (array_agg(price_cents ORDER BY seq DESC))[1] AS c, max(seq) AS seq
    FROM market_prices WHERE ticker = ${ticker} AND at >= ${from} GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({ at: r.t.getTime(), o: r.o, h: r.h, l: r.l, c: r.c, seq: r.seq }));
}

export async function priceSpan(sql: Sql, ticker: string): Promise<{ first: number; last: number } | null> {
  const [row] = await sql<{ first: Date | null; last: Date | null }[]>`
    SELECT (SELECT at FROM market_prices WHERE ticker = ${ticker} ORDER BY seq LIMIT 1) AS first,
           (SELECT at FROM market_prices WHERE ticker = ${ticker} ORDER BY seq DESC LIMIT 1) AS last`;
  return row?.first && row.last ? { first: row.first.getTime(), last: row.last.getTime() } : null;
}

/** Competitions that traded inside a window, for session separators on charts. */
export async function sessionsBetween(sql: Sql, from: Date, to: Date): Promise<{ id: string; opensAt: number; closesAt: number }[]> {
  const rows = await sql<{ id: string; opens_at: Date; closes_at: Date }[]>`
    SELECT id, opens_at, closes_at FROM sessions WHERE start_seq IS NOT NULL AND closes_at >= ${from} AND opens_at <= ${to} ORDER BY opens_at`;
  return rows.map((r) => ({ id: r.id, opensAt: r.opens_at.getTime(), closesAt: r.closes_at.getTime() }));
}

export async function tradesFor(sql: Sql, participantId: string, limit: number): Promise<TradeInfo[]> {
  const rows = await sql<{ id: number; executed_at: Date; ticker: string; side: 'buy' | 'sell'; quantity: number; price_cents: number; total_cents: number; realized_cents: number }[]>`
    SELECT id, executed_at, ticker, side, quantity, price_cents, total_cents, realized_cents FROM trades
    WHERE participant_id = ${participantId} ORDER BY id DESC LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, at: r.executed_at.getTime(), ticker: r.ticker, side: r.side, qty: r.quantity, price: r.price_cents, total: r.total_cents, realized: r.realized_cents }));
}

// ---------------------------------------------------------------- dashboard

/** Each company's first recorded price: the base of the equal-weighted indices. */
export async function firstPrices(sql: Sql, tickers: string[]): Promise<Record<string, number>> {
  const rows = await sql<{ ticker: string; price_cents: number | null }[]>`
    SELECT t.ticker, (SELECT price_cents FROM market_prices m WHERE m.ticker = t.ticker ORDER BY seq LIMIT 1) AS price_cents
    FROM unnest(${tickers}::text[]) AS t(ticker)`;
  return Object.fromEntries(rows.flatMap((r) => (r.price_cents ? [[r.ticker, r.price_cents]] : [])));
}

/** Equal-weighted index bars since `from`: the mean of each member's bucket close over its base. */
export async function indexBars(sql: Sql, base: Record<string, number>, from: Date, bucketMs: number): Promise<PricePoint[]> {
  const tickers = Object.keys(base);
  const rows = await sql<{ t: Date; r: number; seq: number }[]>`
    SELECT x.t, avg(x.c::float8 / b.base) AS r, max(x.seq) AS seq FROM (
      SELECT ticker, date_bin(make_interval(secs => ${bucketMs / 1000}), at, timestamptz 'epoch') AS t,
        (array_agg(price_cents ORDER BY seq DESC))[1] AS c, max(seq) AS seq
      FROM market_prices WHERE ticker = ANY(${tickers}::text[]) AND at >= ${from} GROUP BY 1, 2) x
    JOIN unnest(${tickers}::text[], ${tickers.map((t) => base[t]!)}::int[]) AS b(ticker, base) USING (ticker)
    GROUP BY x.t ORDER BY x.t`;
  return rows.map((row) => {
    const level = Math.round(row.r * 100_000);
    return { at: row.t.getTime(), o: level, h: level, l: level, c: level, seq: Number(row.seq) };
  });
}

/** Executed trades per company in one competition. */
export async function tradeActivity(sql: Sql, sessionId: string) {
  const rows = await sql<{ ticker: string; trades: number; shares: number; turnover: number }[]>`
    SELECT t.ticker, count(*)::int AS trades, sum(t.quantity)::int AS shares, sum(t.total_cents)::float8 AS turnover
    FROM trades t JOIN participants p ON p.id = t.participant_id WHERE p.session_id = ${sessionId}
    GROUP BY t.ticker ORDER BY trades DESC`;
  return rows;
}

/**
 * Every company's price at each of these market seqs, or the latest one before it when the market did
 * not tick there. The lookback is bounded (a thousand ticks) so each lookup stays a short index scan.
 */
export async function pricesAtSeqs(sql: Sql, tickers: string[], seqs: number[]): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>();
  if (!seqs.length) return out;
  const rows = await sql<{ want: number; ticker: string; price_cents: number }[]>`
    SELECT w.want, t.ticker, p.price_cents FROM unnest(${seqs}::bigint[]) AS w(want) CROSS JOIN unnest(${tickers}::text[]) AS t(ticker)
    CROSS JOIN LATERAL (SELECT price_cents FROM market_prices m WHERE m.ticker = t.ticker AND m.seq <= w.want AND m.seq > w.want - 1000
      ORDER BY m.seq DESC LIMIT 1) p`;
  for (const r of rows) {
    const want = Number(r.want);
    if (!out.has(want)) out.set(want, new Map());
    out.get(want)!.set(r.ticker, r.price_cents);
  }
  return out;
}

/** The last market seq of each competition: its bell seq plus the ticks it actually played. */
export async function sessionEndSeqs(sql: Sql, ids: string[]): Promise<Map<string, number>> {
  const rows = await sql<{ id: string; end_seq: number }[]>`
    SELECT id, start_seq + least((config->>'totalTicks')::int,
      floor(extract(epoch FROM closes_at - opens_at) * 1000 / (config->>'tickMs')::int)::int) AS end_seq
    FROM sessions WHERE id = ANY(${ids}::uuid[]) AND start_seq IS NOT NULL`;
  return new Map(rows.map((r) => [r.id, Number(r.end_seq)]));
}
