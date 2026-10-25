import { useMemo } from 'react';
import { moneyWhole } from './format';
import { useGame, type AssetInfo, type GameState } from './game';

import { STARTING_CASH } from '../../../server/src/trading/portfolio';

export { STARTING_CASH };
export const PURSE = moneyWhole(STARTING_CASH);

export interface Holding {
  asset: AssetInfo;
  index: number;
  qty: number;
  cost: number;
  realized: number;
  price: number;
  value: number;
  unrealized: number;
}

/**
 * The one portfolio calculation every screen uses: the server's book times the latest shared prices.
 * Market value = shares x price; unrealised = market value - remaining cost (average cost); portfolio
 * value = cash + market values; profit = value - starting capital. Realised profit is already inside
 * cash, so it is reported, never added to the value a second time.
 */
export function valuation(s: Pick<GameState, 'book' | 'prices' | 'assets' | 'index'>, start: number) {
  const holdings: Holding[] = (s.book?.positions ?? []).flatMap((p) => {
    const i = s.index.get(p.ticker);
    if (i === undefined) return [];
    const price = s.prices[i] ?? 0;
    return [{ asset: s.assets[i]!, index: i, qty: p.qty, cost: p.cost, realized: p.realized, price, value: p.qty * price, unrealized: p.qty * price - p.cost }];
  });
  const held = holdings.filter((h) => h.qty > 0);
  const invested = held.reduce((sum, h) => sum + h.value, 0);
  const cash = s.book?.cash ?? start;
  const value = cash + invested;
  return {
    holdings: held,
    cash,
    invested,
    value,
    unrealized: held.reduce((sum, h) => sum + h.unrealized, 0),
    realized: holdings.reduce((sum, h) => sum + h.realized, 0),
    start,
    pnl: value - start,
    bps: Math.round(((value - start) * 10_000) / start),
    byTicker: new Map(holdings.map((h) => [h.asset.ticker, h])),
  };
}

/** Live valuation for display only; the leaderboard and the final ranking are computed on the server from the same numbers. */
export function usePortfolio() {
  const book = useGame((s) => s.book);
  const prices = useGame((s) => s.prices);
  const assets = useGame((s) => s.assets);
  const index = useGame((s) => s.index);
  // The purse this competition was dealt, as recorded when it was created.
  const start = useGame((s) => s.session?.startingCash ?? STARTING_CASH);
  return useMemo(() => valuation({ book, prices, assets, index }, start), [book, prices, assets, index, start]);
}
