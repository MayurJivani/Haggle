import type { Sql } from '../db/db.js';
import type { Asset } from '../market/assets.js';
import type { ScheduledEvent } from '../market/events.js';
import type { PlayerResult } from '../protocol.js';
import { STARTING_CASH, type Fill, type Position } from '../trading/portfolio.js';

export interface SessionRow {
  id: string;
  seed: number;
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
}

export async function upsertAssets(sql: Sql, assets: Asset[]) {
  for (const a of assets) {
    await sql`
      INSERT INTO assets (ticker, name, sector, description, base_price_cents, volatility, beta, sensitivities)
      VALUES (${a.ticker}, ${a.name}, ${a.sector}, ${a.description}, ${a.base}, ${a.vol}, ${a.beta}, ${sql.json(a.sens)})
      ON CONFLICT (ticker) DO UPDATE SET name = excluded.name, sector = excluded.sector, description = excluded.description,
        base_price_cents = excluded.base_price_cents, volatility = excluded.volatility, beta = excluded.beta,
        sensitivities = excluded.sensitivities`;
  }
}

export async function liveSession(sql: Sql): Promise<SessionRow | null> {
  const [row] = await sql<SessionRow[]>`
    SELECT id, seed, status, config, opens_at, closes_at, finished_at FROM sessions WHERE status <> 'finished'`;
  return row ?? null;
}

export async function createSession(sql: Sql, seed: number, opensAt: Date, closesAt: Date, config: SessionConfig): Promise<SessionRow> {
  const [row] = await sql<SessionRow[]>`
    INSERT INTO sessions (seed, status, config, opens_at, closes_at)
    VALUES (${seed}, 'lobby', ${sql.json({ ...config })}, ${opensAt}, ${closesAt})
    RETURNING id, seed, status, config, opens_at, closes_at, finished_at`;
  return row!;
}

export async function setSessionTimes(sql: Sql, id: string, opensAt: Date, closesAt: Date) {
  await sql`UPDATE sessions SET opens_at = ${opensAt}, closes_at = ${closesAt} WHERE id = ${id} AND status = 'lobby'`;
}

export async function markTrading(sql: Sql, id: string) {
  await sql`UPDATE sessions SET status = 'trading' WHERE id = ${id} AND status = 'lobby'`;
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
export async function joinSession(sql: Sql, sessionId: string, userId: string): Promise<{ id: string; joinedAt: Date; created: boolean }> {
  return sql.begin(async (tx) => {
    const [p] = await tx<{ id: string; joined_at: Date }[]>`
      INSERT INTO participants (session_id, user_id, cash_cents) VALUES (${sessionId}, ${userId}, ${STARTING_CASH})
      ON CONFLICT (session_id, user_id) DO NOTHING RETURNING id, joined_at`;
    if (!p) {
      const [existing] = await tx<{ id: string; joined_at: Date }[]>`
        SELECT id, joined_at FROM participants WHERE session_id = ${sessionId} AND user_id = ${userId}`;
      return { id: existing!.id, joinedAt: existing!.joined_at, created: false };
    }
    await tx`INSERT INTO ledger (participant_id, kind, amount_cents, balance_after_cents) VALUES (${p.id}, 'grant', ${STARTING_CASH}, ${STARTING_CASH})`;
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

export async function recordEvent(sql: Sql, sessionId: string, ev: ScheduledEvent, assets: Asset[]) {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO market_events (session_id, seq, template, headline, description, severity, scope, target, tick, duration)
      VALUES (${sessionId}, ${ev.seq}, ${ev.template}, ${ev.headline}, ${ev.description}, ${ev.severity}, ${ev.scope}, ${ev.target}, ${ev.tick}, ${ev.duration})
      ON CONFLICT (session_id, seq) DO NOTHING RETURNING id`;
    if (!row) return;
    for (const e of ev.effects) {
      await tx`INSERT INTO market_event_effects (event_id, ticker, impact_bps) VALUES (${row.id}, ${assets[e.asset]!.ticker}, ${Math.round(e.pct * 10_000)})`;
    }
  });
}

export async function recordPrices(sql: Sql, sessionId: string, tickers: string[], fromTick: number, history: Int32Array[], toTick: number) {
  const ticks: number[] = [];
  const names: string[] = [];
  const prices: number[] = [];
  for (let t = fromTick; t <= toTick; t++) {
    tickers.forEach((ticker, i) => {
      ticks.push(t);
      names.push(ticker);
      prices.push(history[i]![t]!);
    });
  }
  if (!ticks.length) return;
  await sql`
    INSERT INTO price_history (session_id, tick, ticker, price_cents)
    SELECT ${sessionId}, * FROM unnest(${ticks}::int[], ${names}::text[], ${prices}::int[])
    ON CONFLICT DO NOTHING`;
}

export async function recordSnapshot(sql: Sql, sessionId: string, tick: number, ranking: unknown) {
  await sql`INSERT INTO leaderboard_snapshots (session_id, tick, ranking) VALUES (${sessionId}, ${tick}, ${sql.json(ranking as never)}) ON CONFLICT DO NOTHING`;
}

export async function finishSession(sql: Sql, sessionId: string, closing: Record<string, number>, results: PlayerResult[]) {
  await sql.begin(async (tx) => {
    for (const r of results) {
      await tx`
        INSERT INTO results (session_id, participant_id, rank, final_value_cents, return_bps, stats)
        VALUES (${sessionId}, ${r.participantId}, ${r.rank}, ${r.value}, ${r.bps}, ${tx.json(r as never)})
        ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE sessions SET status = 'finished', finished_at = now(), closing_prices = ${tx.json(closing)} WHERE id = ${sessionId}`;
  });
}

export async function resultFor(sql: Sql, participantId: string): Promise<PlayerResult | null> {
  const [row] = await sql<{ stats: PlayerResult }[]>`SELECT stats FROM results WHERE participant_id = ${participantId}`;
  return row?.stats ?? null;
}

export async function sessionResults(sql: Sql, sessionId: string, limit: number): Promise<PlayerResult[]> {
  const rows = await sql<{ stats: PlayerResult }[]>`SELECT stats FROM results WHERE session_id = ${sessionId} ORDER BY rank LIMIT ${limit}`;
  return rows.map((r) => r.stats);
}
