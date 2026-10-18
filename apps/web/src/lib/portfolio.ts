import { useMemo } from 'react';
import { useGame, type AssetInfo } from './game';

export const STARTING_CASH = 100_000;

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
  return useMemo(() => {
    const index = new Map(assets.map((a, i) => [a.ticker, i]));
    const holdings: Holding[] = (book?.positions ?? []).map((p) => {
      const i = index.get(p.ticker) ?? 0;
      const price = prices[i] ?? assets[i]!.base;
      return { asset: assets[i]!, index: i, qty: p.qty, cost: p.cost, realized: p.realized, price, value: p.qty * price, unrealized: p.qty * price - p.cost };
    });
    const held = holdings.filter((h) => h.qty > 0);
    const invested = held.reduce((s, h) => s + h.value, 0);
    const cash = book?.cash ?? STARTING_CASH;
    const value = cash + invested;
    return {
      holdings: held,
      cash,
      invested,
      value,
      unrealized: held.reduce((s, h) => s + h.unrealized, 0),
      realized: holdings.reduce((s, h) => s + h.realized, 0),
      pnl: value - STARTING_CASH,
      bps: Math.round(((value - STARTING_CASH) * 10_000) / STARTING_CASH),
      byTicker: new Map(holdings.map((h) => [h.asset.ticker, h])),
    };
  }, [book, prices, assets]);
}
