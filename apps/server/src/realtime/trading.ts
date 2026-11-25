// The RealTime order engine. The server is the only authority: prices come from the market cache, never
// from the client, and every fill runs in one database transaction holding the account's row lock, so
// two tabs, two requests or a restart cannot spend the same cash twice. Fill rules: docs/realtime.md.
import type { Logger } from 'pino';
import type postgres from 'postgres';
import type { Sql } from '../db/db.js';
import { EXCHANGES, exchangeStatus, tradable } from './calendar.js';
import type { Catalogue } from './catalogue.js';
import { buyCost, dividend, EMPTY, fillBuy, fillSell, MICRO, split, splitPrice, type Holding } from './ledger.js';
import type { Market } from './market.js';
import type { Execution, Instrument, Order, OrderType, Quality, Quote, RejectReason } from './types.js';

export interface Policy {
  maxQuoteAgeMs: number;
  slippageBps: number;
  maxSpreadBps: number;
  delayedFills: boolean;
  extendedHours: boolean;
  partialFills: boolean;
}

/** Cash held for a limit buy over its cost at the limit, for the exchange rate moving before it fills. */
const FX_HEADROOM_BPS = 200n;
export const MAX_QTY = 10_000_000n * MICRO;

export interface PlaceInput {
  clientOrderId: string;
  instrumentId: number;
  side: 'buy' | 'sell';
  type: OrderType;
  /** Micro-shares; or amount in cents for a market buy by value. */
  qty?: number;
  amount?: number;
  limitPrice?: number;
  /** The player confirmed the order may wait for the next session. */
  queue?: boolean;
}

export type PlaceResult = { ok: true; order: Order; duplicate: boolean; execution?: Execution } | { ok: false; reason: RejectReason };

export type TradingEvent = { kind: 'order'; userId: string; order: Order } | { kind: 'fill'; userId: string; execution: Execution; order: Order };

interface OrderRow {
  id: string; account_id: string; client_order_id: string; instrument_id: number; side: 'buy' | 'sell'; type: OrderType; qty: number; filled_qty: number;
  limit_price: number | null; reserved_cents: number; queued: boolean; status: Order['status']; reason: string | null; created_at: Date; updated_at: Date;
}
interface AccountRow { id: string; season_id: string; user_id: string; cash_cents: number; reserved_cents: number }
interface PositionRow { qty: number; reserved_qty: number; cost_cents: number; realized_cents: number }

type Tx = postgres.TransactionSql;
const B = (n: number | string) => BigInt(n);
const holdingOf = (p: PositionRow | undefined): Holding => (p ? { qty: B(p.qty), reserved: B(p.reserved_qty), cost: B(p.cost_cents), realized: B(p.realized_cents) } : EMPTY);

/** Which price a market order fills at, and why. Null when the quote has nothing to trade on. */
export function fillPrice(q: Quote, side: 'buy' | 'sell', p: Pick<Policy, 'slippageBps' | 'maxSpreadBps'>): { price: number; basis: string } | null {
  const spreadOk = q.bid && q.ask && q.ask >= q.bid && ((q.ask - q.bid) * 10_000) / ((q.ask + q.bid) / 2) <= p.maxSpreadBps;
  if (side === 'buy') {
    if (q.ask && (spreadOk || !q.bid)) return { price: q.ask, basis: 'ask' };
    if (q.last) return { price: Math.ceil((q.last * (10_000 + p.slippageBps)) / 10_000), basis: `last+${p.slippageBps}bps` };
    return null;
  }
  if (q.bid && (spreadOk || !q.ask)) return { price: q.bid, basis: 'bid' };
  if (q.last) return { price: Math.floor((q.last * (10_000 - p.slippageBps)) / 10_000), basis: `last-${p.slippageBps}bps` };
  return null;
}

export class Trading {
  /** Instruments with working orders: only their quotes are matched. */
  private working = new Set<number>();
  private chains = new Map<number, Promise<void>>();
  private matchedAt = new Map<number, number>();
  private listeners = new Set<(e: TradingEvent) => void>();

  constructor(private sql: Sql, private catalogue: Catalogue, private market: Market, private policy: Policy, private now: () => number, private log: Logger) {}

  async start() {
    const rows = await this.sql<{ instrument_id: number }[]>`SELECT DISTINCT instrument_id FROM rt_orders WHERE status IN ('open', 'partially_filled')`;
    this.working = new Set(rows.map((r) => r.instrument_id));
    this.market.onQuotes((qs) => {
      for (const q of qs) if (this.working.has(q.id)) this.enqueue(q.id);
    });
  }

  workingInstruments() {
    return [...this.working];
  }

  on(fn: (e: TradingEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit(e: TradingEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** Why a quote cannot be traded on now, or null when it can. */
  quoteProblem(i: Instrument, q: Quote | undefined): RejectReason | null {
    if (i.status === 'delisted') return 'delisted';
    if (i.status === 'halted' || q?.halted) return 'halted';
    if (!q || (!q.last && !q.bid && !q.ask)) return 'no_quote';
    const t = this.now();
    if (t - q.at - q.delayMin * 60_000 > this.policy.maxQuoteAgeMs) return 'stale_quote';
    if (q.quality === 'eod' || (q.quality === 'delayed' && !this.policy.delayedFills)) return 'delayed_quote';
    return null;
  }

  private sessionOpen(i: Instrument, type: OrderType) {
    const ex = EXCHANGES[i.exchange];
    return tradable(exchangeStatus(i.exchange, this.now()).state, type, this.policy.extendedHours && !!ex.pre);
  }

  // ---------------------------------------------------------------- seasons

  /** `startingCents` is the player's own pick; without one the season's default applies. */
  async join(userId: string, seasonId: string, startingCents?: number): Promise<{ ok: true; accountId: string } | { ok: false; reason: 'season_closed' }> {
    return this.sql.begin(async (tx) => {
      const [s] = await tx<{ starting_cash_cents: number; status: string; join_until: Date | null; ends_at: Date | null }[]>`
        SELECT starting_cash_cents, status, join_until, ends_at FROM rt_seasons WHERE id = ${seasonId} FOR SHARE`;
      const [had] = await tx<{ id: string }[]>`SELECT id FROM rt_accounts WHERE season_id = ${seasonId} AND user_id = ${userId}`;
      if (had) return { ok: true as const, accountId: had.id };
      const t = this.now();
      if (!s || s.status === 'finished' || (s.join_until && t >= s.join_until.getTime()) || (s.ends_at && t >= s.ends_at.getTime())) return { ok: false as const, reason: 'season_closed' as const };
      const cash = startingCents ?? s.starting_cash_cents;
      const [a] = await tx<{ id: string }[]>`
        INSERT INTO rt_accounts (season_id, user_id, cash_cents, starting_cash_cents) VALUES (${seasonId}, ${userId}, ${cash}, ${cash})
        RETURNING id`;
      await tx`INSERT INTO rt_ledger (account_id, kind, amount_cents, balance_after_cents, note) VALUES (${a!.id}, 'grant', ${cash}, ${cash}, 'Starting cash')`;
      return { ok: true as const, accountId: a!.id };
    });
  }

  // ---------------------------------------------------------------- orders

  async place(userId: string, seasonId: string, input: PlaceInput): Promise<PlaceResult> {
    const i = await this.catalogue.get(input.instrumentId);
    if (!i) return { ok: false, reason: 'unknown_instrument' };
    if (i.kind === 'index') return { ok: false, reason: 'not_supported' };
    const fx = this.market.fx(i.currency);
    if (!fx) return { ok: false, reason: 'no_quote' };
    const open = this.sessionOpen(i, input.type);
    if (input.type === 'market') {
      if (!open) return { ok: false, reason: 'market_closed' };
      // An order is priced on the freshest quote there is, not on whatever the last poll left.
      if (this.quoteProblem(i, this.market.quote(i.id))) await this.market.refresh([i]).catch(() => {});
      const why = this.quoteProblem(i, this.market.quote(i.id));
      if (why) return { ok: false, reason: why };
    } else {
      if (!input.limitPrice || !Number.isSafeInteger(input.limitPrice) || input.limitPrice < 1) return { ok: false, reason: 'invalid_price' };
      if (!open && !input.queue) return { ok: false, reason: 'market_closed' };
      if (i.status !== 'active') return { ok: false, reason: i.status === 'delisted' ? 'delisted' : 'halted' };
    }

    const res = await this.sql.begin(async (tx): Promise<PlaceResult> => {
      const [acc] = await tx<AccountRow[]>`SELECT id, season_id, user_id, cash_cents, reserved_cents FROM rt_accounts WHERE season_id = ${seasonId} AND user_id = ${userId} FOR UPDATE`;
      if (!acc) return { ok: false, reason: 'not_joined' };
      const [dup] = await tx<OrderRow[]>`SELECT * FROM rt_orders WHERE account_id = ${acc.id} AND client_order_id = ${input.clientOrderId}`;
      if (dup) return { ok: true, order: this.view(dup, i), duplicate: true };
      const [season] = await tx<{ status: string; ends_at: Date | null }[]>`SELECT status, ends_at FROM rt_seasons WHERE id = ${seasonId}`;
      if (!season || season.status !== 'active' || (season.ends_at && this.now() >= season.ends_at.getTime())) return { ok: false, reason: 'season_closed' };
      const [pos] = await tx<PositionRow[]>`SELECT qty, reserved_qty, cost_cents, realized_cents FROM rt_positions WHERE account_id = ${acc.id} AND instrument_id = ${i.id} FOR UPDATE`;
      const account = { cash: B(acc.cash_cents), reserved: B(acc.reserved_cents) };
      const holding = holdingOf(pos);

      if (input.type === 'market') {
        const q = this.market.quote(i.id)!;
        const fp = fillPrice(q, input.side, this.policy);
        if (!fp) return { ok: false, reason: 'no_quote' };
        let qty: bigint;
        if (input.amount !== undefined) {
          if (input.side !== 'buy' || !Number.isSafeInteger(input.amount) || input.amount < 1) return { ok: false, reason: 'invalid_quantity' };
          qty = (B(input.amount) * fx) / B(fp.price);
        } else qty = B(input.qty ?? 0);
        if (qty < 1n || qty > MAX_QTY) return { ok: false, reason: 'invalid_quantity' };
        const fill = input.side === 'buy' ? fillBuy(account, holding, qty, B(fp.price), fx) : fillSell(account, holding, qty, B(fp.price), fx);
        if (!fill.ok) return fill;
        const [o] = await tx<OrderRow[]>`
          INSERT INTO rt_orders (account_id, client_order_id, instrument_id, side, type, qty, filled_qty, status)
          VALUES (${acc.id}, ${input.clientOrderId}, ${i.id}, ${input.side}, 'market', ${Number(qty)}, ${Number(qty)}, 'filled') RETURNING *`;
        const execution = await this.record(tx, acc.id, o!, i, input.side, qty, fp.price, fx, fill, q, fp.basis);
        return { ok: true, order: this.view(o!, i), duplicate: false, execution };
      }

      const qty = B(input.qty ?? 0);
      if (qty < 1n || qty > MAX_QTY) return { ok: false, reason: 'invalid_quantity' };
      let reserve = 0n;
      if (input.side === 'buy') {
        reserve = (buyCost(qty, B(input.limitPrice!), fx) * (10_000n + FX_HEADROOM_BPS) + 9_999n) / 10_000n;
        if (reserve > account.cash - account.reserved) return { ok: false, reason: 'insufficient_cash' };
        await tx`UPDATE rt_accounts SET reserved_cents = reserved_cents + ${Number(reserve)} WHERE id = ${acc.id}`;
      } else {
        if (qty > holding.qty - holding.reserved) return { ok: false, reason: 'insufficient_shares' };
        await tx`UPDATE rt_positions SET reserved_qty = reserved_qty + ${Number(qty)} WHERE account_id = ${acc.id} AND instrument_id = ${i.id}`;
      }
      const [o] = await tx<OrderRow[]>`
        INSERT INTO rt_orders (account_id, client_order_id, instrument_id, side, type, qty, limit_price, reserved_cents, queued, status)
        VALUES (${acc.id}, ${input.clientOrderId}, ${i.id}, ${input.side}, 'limit', ${Number(qty)}, ${input.limitPrice!}, ${Number(reserve)}, ${!open}, 'open') RETURNING *`;
      return { ok: true, order: this.view(o!, i), duplicate: false };
    });

    if (res.ok && !res.duplicate) {
      this.emit({ kind: 'order', userId, order: res.order });
      if (res.execution) this.emit({ kind: 'fill', userId, order: res.order, execution: res.execution });
      if (res.order.status === 'open') {
        this.working.add(i.id);
        this.matchedAt.delete(i.id);
        this.enqueue(i.id);
      }
    }
    return res;
  }

  async cancel(userId: string, orderId: string, reason = 'Cancelled by you'): Promise<{ ok: true; order: Order } | { ok: false; reason: 'not_found' }> {
    const r = await this.sql.begin(async (tx) => {
      const [o] = await tx<(OrderRow & { user_id: string })[]>`
        SELECT o.*, a.user_id FROM rt_orders o JOIN rt_accounts a ON a.id = o.account_id WHERE o.id = ${orderId} FOR UPDATE OF o, a`;
      if (!o || o.user_id !== userId) return null;
      if (o.status !== 'open' && o.status !== 'partially_filled') return o;
      return this.release(tx, o, 'cancelled', reason);
    });
    if (!r) return { ok: false, reason: 'not_found' };
    const i = (await this.catalogue.get(r.instrument_id))!;
    const order = this.view(r, i);
    this.emit({ kind: 'order', userId, order });
    return { ok: true, order };
  }

  /** Ends a working order and hands back what it held: the cash for a buy, the shares for a sell. */
  private async release(tx: Tx, o: OrderRow, status: 'cancelled' | 'rejected', reason: string): Promise<OrderRow> {
    if (o.side === 'buy') await tx`UPDATE rt_accounts SET reserved_cents = reserved_cents - ${o.reserved_cents} WHERE id = ${o.account_id}`;
    else await tx`UPDATE rt_positions SET reserved_qty = reserved_qty - ${o.qty - o.filled_qty} WHERE account_id = ${o.account_id} AND instrument_id = ${o.instrument_id}`;
    const [u] = await tx<OrderRow[]>`UPDATE rt_orders SET status = ${status}, reason = ${reason}, reserved_cents = 0, updated_at = now() WHERE id = ${o.id} RETURNING *`;
    return u!;
  }

  private async record(
    tx: Tx, accountId: string, o: OrderRow, i: Instrument, side: 'buy' | 'sell', qty: bigint, price: number, fx: bigint,
    fill: { total: bigint; realized: bigint; account: { cash: bigint; reserved: bigint }; holding: Holding }, q: Quote, basis: string,
  ): Promise<Execution> {
    const fxText = (Number(fx) / 1e8).toString();
    const [e] = await tx<{ id: number; executed_at: Date }[]>`
      INSERT INTO rt_executions (order_id, account_id, instrument_id, side, qty, price, currency, fx_per_eur, total_cents, realized_cents, quote_at, quality, basis, executed_at)
      VALUES (${o.id}, ${accountId}, ${i.id}, ${side}, ${Number(qty)}, ${price}, ${i.currency}, ${fxText}, ${Number(fill.total)}, ${Number(fill.realized)},
        ${new Date(q.at)}, ${q.quality}, ${basis}, ${new Date(this.now())})
      RETURNING id, executed_at`;
    await tx`UPDATE rt_accounts SET cash_cents = ${Number(fill.account.cash)}, reserved_cents = ${Number(fill.account.reserved)} WHERE id = ${accountId}`;
    await tx`
      INSERT INTO rt_positions (account_id, instrument_id, qty, reserved_qty, cost_cents, realized_cents)
      VALUES (${accountId}, ${i.id}, ${Number(fill.holding.qty)}, ${Number(fill.holding.reserved)}, ${Number(fill.holding.cost)}, ${Number(fill.holding.realized)})
      ON CONFLICT (account_id, instrument_id) DO UPDATE SET qty = EXCLUDED.qty, reserved_qty = EXCLUDED.reserved_qty, cost_cents = EXCLUDED.cost_cents, realized_cents = EXCLUDED.realized_cents`;
    await tx`
      INSERT INTO rt_ledger (account_id, kind, execution_id, amount_cents, balance_after_cents, note)
      VALUES (${accountId}, ${side}, ${e!.id}, ${Number(side === 'buy' ? -fill.total : fill.total)}, ${Number(fill.account.cash)}, ${`${side === 'buy' ? 'Bought' : 'Sold'} ${i.symbol}`})`;
    return {
      id: e!.id, orderId: o.id, instrument: { id: i.id, symbol: i.symbol, name: i.name, currency: i.currency }, side, qty: Number(qty), price, fxPerEur: fxText,
      total: Number(fill.total), realized: Number(fill.realized), quoteAt: q.at, quality: q.quality as Quality, basis, at: e!.executed_at.getTime(),
    };
  }

  // ---------------------------------------------------------------- matching

  /** One match at a time per instrument, so the same quote never fills an order twice. */
  private enqueue(id: number) {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.match(id)).catch((err) => this.log.error({ err, id }, 'limit match failed'));
    this.chains.set(id, next);
    void next.finally(() => this.chains.get(id) === next && this.chains.delete(id));
  }

  /** Waits for every queued match (tests, shutdown). */
  async settle() {
    while (this.chains.size) await Promise.all(this.chains.values());
  }

  private async match(id: number) {
    const i = await this.catalogue.get(id);
    const q = this.market.quote(id);
    if (!i || !q || !this.sessionOpen(i, 'limit') || this.quoteProblem(i, q)) return;
    // A quote is offered once: a partial fill waits for a newer quote before it fills again.
    if ((this.matchedAt.get(id) ?? -1) >= q.at) return;
    this.matchedAt.set(id, q.at);
    const orders = await this.sql<{ id: string }[]>`SELECT id FROM rt_orders WHERE instrument_id = ${id} AND status IN ('open', 'partially_filled') ORDER BY created_at`;
    if (!orders.length) {
      this.working.delete(id);
      return;
    }
    for (const { id: orderId } of orders) await this.tryFill(orderId, i, q);
  }

  private async tryFill(orderId: string, i: Instrument, q: Quote) {
    const fx = this.market.fx(i.currency);
    if (!fx) return;
    const out = await this.sql.begin(async (tx) => {
      const [o] = await tx<(OrderRow & { user_id: string })[]>`
        SELECT o.*, a.user_id FROM rt_orders o JOIN rt_accounts a ON a.id = o.account_id WHERE o.id = ${orderId} FOR UPDATE OF o, a`;
      if (!o || (o.status !== 'open' && o.status !== 'partially_filled')) return null;
      const [season] = await tx<{ status: string }[]>`SELECT s.status FROM rt_seasons s JOIN rt_accounts a ON a.season_id = s.id WHERE a.id = ${o.account_id}`;
      if (season?.status !== 'active') return null;
      const limit = o.limit_price!;
      const px = o.side === 'buy' ? (q.ask ?? q.last) : (q.bid ?? q.last);
      if (!px || (o.side === 'buy' ? px > limit : px < limit)) return null;
      const basis = (o.side === 'buy' ? q.ask : q.bid) ? (o.side === 'buy' ? 'ask' : 'bid') : 'last';
      const remaining = B(o.qty - o.filled_qty);
      const size = o.side === 'buy' ? q.askSize : q.bidSize;
      const qty = this.policy.partialFills && size && size > 0 ? (B(Math.floor(size * 1e6)) < remaining ? B(Math.floor(size * 1e6)) : remaining) : remaining;
      const [acc] = await tx<AccountRow[]>`SELECT id, season_id, user_id, cash_cents, reserved_cents FROM rt_accounts WHERE id = ${o.account_id}`;
      const [pos] = await tx<PositionRow[]>`SELECT qty, reserved_qty, cost_cents, realized_cents FROM rt_positions WHERE account_id = ${o.account_id} AND instrument_id = ${i.id} FOR UPDATE`;
      const account = { cash: B(acc!.cash_cents), reserved: B(acc!.reserved_cents) };
      const release = o.side === 'buy' ? (qty === remaining ? B(o.reserved_cents) : (B(o.reserved_cents) * qty) / remaining) : 0n;
      const fill = o.side === 'buy' ? fillBuy(account, holdingOf(pos), qty, B(px), fx, release) : fillSell(account, holdingOf(pos), qty, B(px), fx, true);
      if (!fill.ok) {
        const r = await this.release(tx, o, 'rejected', fill.reason === 'insufficient_cash' ? 'Not enough cash at the fill price (exchange rate moved)' : 'Shares no longer held');
        return { o: r, userId: o.user_id };
      }
      const filled = o.filled_qty + Number(qty);
      const [u] = await tx<OrderRow[]>`
        UPDATE rt_orders SET filled_qty = ${filled}, status = ${filled === o.qty ? 'filled' : 'partially_filled'}, reserved_cents = ${Number(B(o.reserved_cents) - release)}, updated_at = now()
        WHERE id = ${o.id} RETURNING *`;
      const execution = await this.record(tx, o.account_id, u!, i, o.side, qty, px, fx, fill, q, basis);
      return { o: u!, userId: o.user_id, execution };
    });
    if (!out) return;
    const order = this.view(out.o, i);
    this.emit({ kind: 'order', userId: out.userId, order });
    if (out.execution) this.emit({ kind: 'fill', userId: out.userId, order, execution: out.execution });
  }

  // ---------------------------------------------------------------- corporate actions

  /**
   * A split: every holder gets to/from as many shares at the same total cost, and working orders on the
   * instrument are rescaled so a limit means the same money. Runs once per action (applied_at).
   */
  async applySplit(actionId: number, instrumentId: number, from: number, to: number) {
    await this.sql.begin(async (tx) => {
      const [a] = await tx<{ applied_at: Date | null }[]>`SELECT applied_at FROM rt_corporate_actions WHERE id = ${actionId} FOR UPDATE`;
      if (!a || a.applied_at) return;
      const pos = await tx<(PositionRow & { account_id: string })[]>`SELECT account_id, qty, reserved_qty, cost_cents, realized_cents FROM rt_positions WHERE instrument_id = ${instrumentId} AND qty > 0 FOR UPDATE`;
      for (const p of pos) {
        const h = split(holdingOf(p), B(from), B(to));
        await tx`UPDATE rt_positions SET qty = ${Number(h.qty)}, reserved_qty = ${Number(h.reserved)} WHERE account_id = ${p.account_id} AND instrument_id = ${instrumentId}`;
      }
      const orders = await tx<OrderRow[]>`SELECT * FROM rt_orders WHERE instrument_id = ${instrumentId} AND status IN ('open', 'partially_filled') FOR UPDATE`;
      for (const o of orders) {
        const qty = Number((B(o.qty) * B(to)) / B(from));
        const filled = Number((B(o.filled_qty) * B(to)) / B(from));
        await tx`UPDATE rt_orders SET qty = ${qty}, filled_qty = ${filled}, limit_price = ${Number(splitPrice(B(o.limit_price!), B(from), B(to)))}, updated_at = now() WHERE id = ${o.id}`;
      }
      await tx`UPDATE rt_corporate_actions SET applied_at = now() WHERE id = ${actionId}`;
    });
    // Cached quotes from before the split are in the old share count.
    this.market.quotes.delete(instrumentId);
  }

  /** A cash dividend to everyone holding the instrument at the ex-date, converted at today's rate. */
  async applyDividend(actionId: number, instrumentId: number, perShare: number) {
    const i = await this.catalogue.get(instrumentId);
    const fx = i && this.market.fx(i.currency);
    if (!i || !fx) return;
    await this.sql.begin(async (tx) => {
      const [a] = await tx<{ applied_at: Date | null }[]>`SELECT applied_at FROM rt_corporate_actions WHERE id = ${actionId} FOR UPDATE`;
      if (!a || a.applied_at) return;
      const pos = await tx<{ account_id: string; qty: number }[]>`SELECT account_id, qty FROM rt_positions WHERE instrument_id = ${instrumentId} AND qty > 0`;
      for (const p of pos) {
        const cents = dividend(B(p.qty), B(perShare), fx);
        if (cents <= 0n) continue;
        const [acc] = await tx<{ cash_cents: number }[]>`UPDATE rt_accounts SET cash_cents = cash_cents + ${Number(cents)} WHERE id = ${p.account_id} RETURNING cash_cents`;
        await tx`UPDATE rt_positions SET realized_cents = realized_cents + ${Number(cents)} WHERE account_id = ${p.account_id} AND instrument_id = ${instrumentId}`;
        await tx`INSERT INTO rt_ledger (account_id, kind, amount_cents, balance_after_cents, note) VALUES (${p.account_id}, 'dividend', ${Number(cents)}, ${acc!.cash_cents}, ${`Dividend ${i.symbol}`})`;
      }
      await tx`UPDATE rt_corporate_actions SET applied_at = now() WHERE id = ${actionId}`;
    });
  }

  /** Cancels every working order of a season (it has ended). */
  async cancelSeason(seasonId: string, reason: string) {
    const rows = await this.sql<{ id: string; user_id: string }[]>`
      SELECT o.id, a.user_id FROM rt_orders o JOIN rt_accounts a ON a.id = o.account_id WHERE a.season_id = ${seasonId} AND o.status IN ('open', 'partially_filled')`;
    for (const r of rows) await this.cancel(r.user_id, r.id, reason);
  }

  /** Cancels working orders on an instrument that can no longer trade (delisted). */
  async cancelInstrument(instrumentId: number, reason: string) {
    const rows = await this.sql<{ id: string; user_id: string }[]>`
      SELECT o.id, a.user_id FROM rt_orders o JOIN rt_accounts a ON a.id = o.account_id WHERE o.instrument_id = ${instrumentId} AND o.status IN ('open', 'partially_filled')`;
    for (const r of rows) await this.cancel(r.user_id, r.id, reason);
  }

  view(o: OrderRow, i: Instrument): Order {
    return {
      id: o.id, clientOrderId: o.client_order_id, instrument: { id: i.id, symbol: i.symbol, name: i.name, exchange: i.exchange, currency: i.currency },
      side: o.side, type: o.type, qty: o.qty, filledQty: o.filled_qty, limitPrice: o.limit_price, reserved: o.reserved_cents, queued: o.queued,
      status: o.status, reason: o.reason, createdAt: o.created_at.getTime(), updatedAt: o.updated_at.getTime(),
    };
  }
}
