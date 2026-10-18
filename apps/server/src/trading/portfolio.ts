// Pure accounting in integer cents. The engine runs these against its in-memory mirror to decide
// an order, and the database constraints enforce the same rules a second time.

export const STARTING_CASH = 100_000;
export const MAX_ORDER_QTY = 100_000;

export interface Position {
  qty: number;
  /** Cost of the shares still held; average cost = cost / qty. */
  cost: number;
  realized: number;
}

export interface Book {
  cash: number;
  positions: Map<string, Position>;
}

export type Side = 'buy' | 'sell';

export type Fill = {
  ok: true;
  side: Side;
  ticker: string;
  qty: number;
  price: number;
  total: number;
  /** Realised profit of this fill (sells only). */
  realized: number;
  cashAfter: number;
  position: Position;
};
export type Reject = { ok: false; reason: 'insufficient_cash' | 'insufficient_shares' | 'invalid_quantity' | 'invalid_price' };

/** Decides an order against a book without mutating it. */
export function quote(book: Book, side: Side, ticker: string, qty: number, price: number): Fill | Reject {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_ORDER_QTY) return { ok: false, reason: 'invalid_quantity' };
  if (!Number.isSafeInteger(price) || price < 1) return { ok: false, reason: 'invalid_price' };
  const pos = book.positions.get(ticker) ?? { qty: 0, cost: 0, realized: 0 };
  const total = qty * price;

  if (side === 'buy') {
    if (total > book.cash) return { ok: false, reason: 'insufficient_cash' };
    return {
      ok: true, side, ticker, qty, price, total, realized: 0,
      cashAfter: book.cash - total,
      position: { qty: pos.qty + qty, cost: pos.cost + total, realized: pos.realized },
    };
  }

  if (qty > pos.qty) return { ok: false, reason: 'insufficient_shares' };
  // Average-cost method; selling everything removes exactly the remaining cost so no cent strands.
  const costOut = qty === pos.qty ? pos.cost : Math.round((pos.cost * qty) / pos.qty);
  const realized = total - costOut;
  return {
    ok: true, side, ticker, qty, price, total, realized,
    cashAfter: book.cash + total,
    position: { qty: pos.qty - qty, cost: pos.cost - costOut, realized: pos.realized + realized },
  };
}

export function apply(book: Book, fill: Fill): void {
  book.cash = fill.cashAfter;
  book.positions.set(fill.ticker, fill.position);
}

/** Cash plus every holding at the given prices. */
export function valueOf(book: Book, priceOf: (ticker: string) => number): number {
  let v = book.cash;
  for (const [ticker, p] of book.positions) v += p.qty * priceOf(ticker);
  return v;
}

/** Basis points of return against the starting cash: 1234 = +12.34%. */
export const returnBps = (value: number) => Math.round(((value - STARTING_CASH) * 10_000) / STARTING_CASH);

/** Realised plus unrealised profit per ticker, for best/worst holding stats. */
export function pnlByTicker(book: Book, priceOf: (ticker: string) => number): { ticker: string; pnl: number }[] {
  return [...book.positions].map(([ticker, p]) => ({ ticker, pnl: p.realized + p.qty * priceOf(ticker) - p.cost }));
}
