import { useMemo } from 'react';
import { peRatio } from '../../../server/src/market/fundamentals';
import { changeBps } from './format';
import { useGame, type AssetInfo } from './game';

export { peRatio };

export interface Metrics {
  asset: AssetInfo;
  index: number;
  price: number;
  /** Change since the competition's opening bell, in basis points. */
  bps: number;
  pe: number | 'N/A' | 'N/M';
  /** Price over the model's fair value: 1.2 = 20% above it. Null without a fair value. */
  vsFair: number | null;
  /** Share of the listing the model rates more expensive than this company, 0-1. */
  cheaperThan: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Every company's live research figures, recomputed from the shared prices. */
export function useResearch() {
  const assets = useGame((s) => s.assets);
  const prices = useGame((s) => s.prices);
  const open = useGame((s) => s.open);
  return useMemo(() => {
    const rows: Metrics[] = assets.map((asset, index) => {
      const price = prices[index] ?? 0;
      const fair = asset.fund.fair?.cents;
      return {
        asset, index, price,
        bps: changeBps(price, open[index] ?? price),
        pe: peRatio(price, asset.fund.epsTtm),
        vsFair: fair ? price / fair : null,
        cheaperThan: null,
      };
    });
    const ranked = rows.filter((r) => r.vsFair !== null).sort((a, b) => a.vsFair! - b.vsFair!);
    ranked.forEach((r, k) => (r.cheaperThan = ranked.length > 1 ? 1 - k / (ranked.length - 1) : null));
    const sectorPe = new Map<string, number | null>();
    for (const sector of new Set(assets.map((a) => a.sector))) {
      sectorPe.set(sector, median(rows.filter((r) => r.asset.sector === sector && typeof r.pe === 'number').map((r) => r.pe as number)));
    }
    return { rows, byTicker: new Map(rows.map((r) => [r.asset.ticker, r])), sectorPe };
  }, [assets, prices, open]);
}

export const peText = (pe: Metrics['pe']) => (typeof pe === 'number' ? (pe >= 1000 ? pe.toFixed(0) : pe.toFixed(1)) : pe);

/**
 * What each sector tends to be exposed to, in plain words: the relationships behind the news, never
 * a call on what to trade.
 */
export const SECTOR_NOTES: Record<string, string> = {
  Technology: 'Valued on profits far in the future, so interest rates matter. Regulation of large platforms and data-centre spending are recurring themes.',
  Semiconductors: 'Cyclical and capital-hungry. Demand from data centres, phones and cars drives orders; supply shortages can raise prices for some and cut output for their customers.',
  Healthcare: 'Driven by trial results and approvals more than by the economy. Pricing reviews are the main policy risk.',
  Finance: 'Banks earn on the gap between lending and deposit rates, so rate moves cut both ways. Funding stress spreads quickly across the sector.',
  Energy: 'Producers follow the oil price. Utilities and renewable developers borrow heavily and are sensitive to rates.',
  Automotive: 'Need chips and parts on time, sell big-ticket items that depend on consumer confidence, and burn fuel in logistics.',
  Consumer: 'Live on household spending. Input costs and shipping disruptions squeeze margins; luxury behaves differently from staples.',
  'E-commerce': 'Spending, delivery costs and platform regulation all reach these businesses; many are valued on growth, which makes rates matter.',
  Telecom: 'Steady subscription revenue and heavy debt: quiet businesses where rates and regulation do most of the moving.',
  'Aerospace & Defence': 'Airliner makers track air travel and fuel; defence companies track government budgets more than the economy.',
  Industrials: 'Order books rise and fall with the economy. Electrification and data-centre power are long-running themes.',
  Materials: 'Miners and chemical makers move with global growth and commodity prices; energy is a large cost for chemicals.',
  'Food & Beverage': 'Defensive demand, but exposed to ingredient, packaging and shipping costs.',
  Media: 'Subscriptions and advertising both lean on consumer spending; debt-heavy studios feel rates.',
  Logistics: 'Fuel is a major cost and shipping capacity sets prices: disruptions hurt shippers of goods and can help those who own the ships.',
};
