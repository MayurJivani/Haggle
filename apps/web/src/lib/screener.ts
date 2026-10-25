// The screener's filters and sort, kept out of the component so they can be tested on plain rows.

import type { Metrics } from './research';

export interface ScreenRow extends Metrics {
  /** Trades executed in this competition, from the server; 0 when none or not loaded. */
  trades: number;
  /** Trailing net income over trailing revenue; null without four reported quarters. */
  margin: number | null;
}

export type Column = 'ticker' | 'sector' | 'price' | 'change' | 'pe' | 'eps' | 'epsGrowth' | 'revenueGrowth' | 'margin' | 'vsFair' | 'trades';

export interface Filters {
  q: string;
  sector: string;
  move: 'all' | 'up' | 'down';
  /** Simulated-price P/E bands; 'none' is loss-makers and companies without four quarters. */
  pe: 'all' | 'lt15' | '15to30' | 'gt30' | 'none';
  profit: 'all' | 'profitable' | 'loss';
  /** Price against the model's fair value. */
  value: 'all' | 'below' | 'above';
  show: 'all' | 'favourites' | 'held';
}

export const NO_FILTERS: Filters = { q: '', sector: '', move: 'all', pe: 'all', profit: 'all', value: 'all', show: 'all' };

export const marginOf = (m: Metrics) => {
  const { netIncomeTtm: ni, revenueTtm: rev } = m.asset.fund;
  return ni === null || !rev ? null : ni / rev;
};

export function screen(rows: ScreenRow[], f: Filters, mine: { favourites: ReadonlySet<string>; held: ReadonlySet<string> }) {
  const needle = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    const a = r.asset;
    if (f.sector && a.sector !== f.sector) return false;
    if (f.move === 'up' && r.bps <= 0) return false;
    if (f.move === 'down' && r.bps >= 0) return false;
    if (f.pe !== 'all') {
      const pe = typeof r.pe === 'number' ? r.pe : null;
      if (f.pe === 'none' ? pe !== null : pe === null || (f.pe === 'lt15' ? pe >= 15 : f.pe === 'gt30' ? pe <= 30 : pe < 15 || pe > 30)) return false;
    }
    if (f.profit !== 'all') {
      const ni = a.fund.netIncomeTtm;
      // Without four quarters profitability is unknown, so it matches neither filter.
      if (ni === null || (f.profit === 'profitable' ? ni <= 0 : ni > 0)) return false;
    }
    if (f.value !== 'all' && (r.vsFair === null || (f.value === 'below' ? r.vsFair >= 1 : r.vsFair <= 1))) return false;
    if (f.show === 'favourites' && !mine.favourites.has(a.ticker)) return false;
    if (f.show === 'held' && !mine.held.has(a.ticker)) return false;
    return !needle || `${a.ticker} ${a.name} ${a.sector} ${a.industry}`.toLowerCase().includes(needle);
  });
}

const key = (r: ScreenRow, c: Column): number | string | null => {
  switch (c) {
    case 'ticker': return r.asset.ticker;
    case 'sector': return r.asset.sector;
    case 'price': return r.price;
    case 'change': return r.bps;
    case 'pe': return typeof r.pe === 'number' ? r.pe : null;
    case 'eps': return r.asset.fund.epsTtm;
    case 'epsGrowth': return r.asset.fund.epsGrowth;
    case 'revenueGrowth': return r.asset.fund.revenueGrowth;
    case 'margin': return r.margin;
    case 'vsFair': return r.vsFair;
    case 'trades': return r.trades;
  }
};

/** Sorts by one column; rows without the figure always go last, whichever the direction. */
export function sortRows(rows: ScreenRow[], c: Column, desc: boolean) {
  return [...rows].sort((a, b) => {
    const x = key(a, c);
    const y = key(b, c);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    const d = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return (desc ? -d : d) || a.asset.ticker.localeCompare(b.asset.ticker);
  });
}
