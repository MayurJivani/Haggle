import { useMemo } from 'react';
import { moneyWhole } from './format';
import { useGame, type AssetInfo } from './game';

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
 * Live valuation for display only: the server's book times the latest shared prices. The leaderboard
 * and the final ranking are computed on the server from the same numbers.
 */
export function usePortfolio() {
  const book = useGame((s) => s.book);
  const prices = useGame((s) => s.prices);
  const assets = useGame((s) => s.assets);
  const index = useGame((s) => s.index);
  // The purse this competition was dealt, as recorded when it was created.
  const start = useGame((s) => s.session?.startingCash ?? STARTING_CASH);
  return useMemo(() => {
    const holdings: Holding[] = (book?.positions ?? []).flatMap((p) => {
      const i = index.get(p.ticker);
      if (i === undefined) return [];
      const price = prices[i] ?? 0;
      return [{ asset: assets[i]!, index: i, qty: p.qty, cost: p.cost, realized: p.realized, price, value: p.qty * price, unrealized: p.qty * price - p.cost }];
    });
    const held = holdings.filter((h) => h.qty > 0);
    const invested = held.reduce((s, h) => s + h.value, 0);
    const cash = book?.cash ?? start;
    const value = cash + invested;
    return {
      holdings: held,
      cash,
      invested,
      value,
      unrealized: held.reduce((s, h) => s + h.unrealized, 0),
      realized: holdings.reduce((s, h) => s + h.realized, 0),
      start,
      pnl: value - start,
      bps: Math.round(((value - start) * 10_000) / start),
      byTicker: new Map(holdings.map((h) => [h.asset.ticker, h])),
    };
  }, [book, prices, assets, index, start]);
}
