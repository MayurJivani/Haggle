import { describe, expect, it } from 'vitest';
import { apply, pnlByTicker, quote, returnBps, STARTING_CASH, valueOf, type Book } from '../src/trading/portfolio.js';

const fresh = (): Book => ({ cash: STARTING_CASH, positions: new Map() });
const fill = (book: Book, side: 'buy' | 'sell', qty: number, price: number, ticker = 'AAPL') => {
  const q = quote(book, side, ticker, qty, price);
  if (!q.ok) throw new Error(q.reason);
  apply(book, q);
  return q;
};

describe('portfolio accounting', () => {
  it('buys move cash into a position at cost', () => {
    const b = fresh();
    fill(b, 'buy', 3, 12_345);
    expect(b.cash).toBe(STARTING_CASH - 37_035);
    expect(b.positions.get('AAPL')).toEqual({ qty: 3, cost: 37_035, realized: 0 });
    expect(valueOf(b, () => 12_345)).toBe(STARTING_CASH);
  });

  it('refuses to spend more than the cash on hand, to the cent', () => {
    const b = fresh();
    expect(quote(b, 'buy', 'X', 1, STARTING_CASH + 1)).toEqual({ ok: false, reason: 'insufficient_cash' });
    expect(quote(b, 'buy', 'X', 1, STARTING_CASH).ok).toBe(true);
  });

  it('refuses to sell shares it does not own', () => {
    const b = fresh();
    expect(quote(b, 'sell', 'AAPL', 1, 100)).toEqual({ ok: false, reason: 'insufficient_shares' });
    fill(b, 'buy', 2, 100);
    expect(quote(b, 'sell', 'AAPL', 3, 100)).toEqual({ ok: false, reason: 'insufficient_shares' });
  });

  it('rejects non-integer, zero and negative quantities', () => {
    const b = fresh();
    for (const qty of [0, -1, 1.5, Number.NaN, 1e9]) expect(quote(b, 'buy', 'AAPL', qty, 100)).toEqual({ ok: false, reason: 'invalid_quantity' });
  });

  it('tracks average cost and realised profit across partial sells', () => {
    const b = fresh();
    fill(b, 'buy', 2, 1_000);
    fill(b, 'buy', 1, 1_300); // avg cost 1100
    const s = fill(b, 'sell', 2, 1_500);
    expect(s.realized).toBe(3_000 - 2_200);
    expect(b.positions.get('AAPL')).toEqual({ qty: 1, cost: 1_100, realized: 800 });
    const last = fill(b, 'sell', 1, 900);
    expect(last.realized).toBe(-200);
    expect(b.positions.get('AAPL')).toEqual({ qty: 0, cost: 0, realized: 600 });
    expect(b.cash).toBe(STARTING_CASH + 600);
  });

  it('never strands a cent of cost when rounding on partial sells', () => {
    const b = fresh();
    fill(b, 'buy', 3, 333);
    fill(b, 'buy', 4, 335);
    while (b.positions.get('AAPL')!.qty > 0) fill(b, 'sell', 1, 400);
    expect(b.positions.get('AAPL')!.cost).toBe(0);
    expect(b.cash).toBe(STARTING_CASH + b.positions.get('AAPL')!.realized);
  });

  it('values = cash + holdings, returns in basis points, pnl per ticker', () => {
    const b = fresh();
    fill(b, 'buy', 10, 5_000, 'A');
    fill(b, 'buy', 5, 4_000, 'B');
    const prices: Record<string, number> = { A: 5_500, B: 3_000 };
    const v = valueOf(b, (t) => prices[t]!);
    expect(v).toBe(STARTING_CASH - 70_000 + 55_000 + 15_000);
    expect(returnBps(v)).toBe(0);
    expect(returnBps(STARTING_CASH + STARTING_CASH * 0.1234)).toBe(1_234);
    expect(pnlByTicker(b, (t) => prices[t]!)).toEqual([{ ticker: 'A', pnl: 5_000 }, { ticker: 'B', pnl: -5_000 }]);
  });
});
