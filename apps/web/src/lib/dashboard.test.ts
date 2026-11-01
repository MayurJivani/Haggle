import { describe, expect, it } from 'vitest';
import { indexLevel } from '../../../server/src/market/dashboard';
import { marketStats, summarize } from './dashboard';
import type { AssetInfo } from './game';
import type { Metrics } from './research';
import { NO_FILTERS, screen, sortRows, type ScreenRow } from './screener';
import { fold, fromHistory } from './series';

const fund = (o: Partial<AssetInfo['fund']> = {}): AssetInfo['fund'] => ({
  epsTtm: 2, revenueTtm: 1000, netIncomeTtm: 100, epsGrowth: 0.1, revenueGrowth: 0.05, latest: null, fair: null, ...o,
});
const row = (ticker: string, sector: string, bps: number, o: Partial<ScreenRow> & { fund?: Partial<AssetInfo['fund']> } = {}): ScreenRow => ({
  asset: { ticker, name: `${ticker} Corp`, exchange: 'X', sector, industry: 'Things', description: '', beta: 1, risk: 'medium', core: true, traits: { growth: 0, cyclical: 1, speculation: 1, debt: 0, oil: 0, defensive: false }, fund: fund(o.fund) },
  index: 0, price: 1000, bps, pe: 20, vsFair: null, cheaperThan: null, trades: 0, margin: 0.1, ...o,
});

const rows = [
  row('AAA', 'Energy', 300, { pe: 10, trades: 4, vsFair: 0.8 }),
  row('BBB', 'Energy', -100, { pe: 'N/M', trades: 9, fund: { netIncomeTtm: -50, epsTtm: -1 }, margin: -0.05 }),
  row('CCC', 'Media', 0, { pe: 'N/A', fund: { netIncomeTtm: null, epsTtm: null }, margin: null }),
  row('DDD', 'Media', -400, { pe: 45, vsFair: 1.3 }),
];
const none = { favourites: new Set<string>(), held: new Set<string>() };
const tickers = (rs: Metrics[]) => rs.map((r) => r.asset.ticker);

describe('market overview', () => {
  const s = marketStats(rows);
  it('counts breadth and averages sectors with equal weights', () => {
    expect([s.up, s.down, s.flat]).toEqual([1, 2, 1]);
    expect(s.bps).toBe(-50);
    expect(s.sectors.map((x) => [x.name, x.bps, x.best.asset.ticker])).toEqual([['Energy', 100, 'AAA'], ['Media', -200, 'CCC']]);
  });
  it('lists only companies that actually moved as gainers and losers', () => {
    expect(tickers(s.gainers)).toEqual(['AAA']);
    expect(tickers(s.losers)).toEqual(['DDD', 'BBB']);
  });
  it('describes the session from the figures', () => {
    expect(summarize(s, 'calm')).toBe(
      'The market is down 0.50% since the bell, with 1 of 4 companies rising and 2 falling. Energy leads (+1.00%), driven by AAA (+3.00%). ' +
        'Media lags (−2.00%), weighed down by DDD (−4.00%). Volatility is calm.',
    );
    expect(summarize(marketStats([]), 'calm')).toBe('');
  });
});

describe('screener', () => {
  it('filters on valuation and profitability without guessing missing figures', () => {
    expect(tickers(screen(rows, { ...NO_FILTERS, pe: 'lt15' }, none))).toEqual(['AAA']);
    expect(tickers(screen(rows, { ...NO_FILTERS, pe: 'gt30' }, none))).toEqual(['DDD']);
    expect(tickers(screen(rows, { ...NO_FILTERS, pe: 'none' }, none))).toEqual(['BBB', 'CCC']);
    // CCC has no trailing figures: it is neither profitable nor loss-making.
    expect(tickers(screen(rows, { ...NO_FILTERS, profit: 'profitable' }, none))).toEqual(['AAA', 'DDD']);
    expect(tickers(screen(rows, { ...NO_FILTERS, profit: 'loss' }, none))).toEqual(['BBB']);
    expect(tickers(screen(rows, { ...NO_FILTERS, value: 'below' }, none))).toEqual(['AAA']);
  });
  it('filters on movement, search, watchlist and holdings', () => {
    expect(tickers(screen(rows, { ...NO_FILTERS, move: 'down' }, none))).toEqual(['BBB', 'DDD']);
    expect(tickers(screen(rows, { ...NO_FILTERS, q: 'ccc corp' }, none))).toEqual(['CCC']);
    expect(tickers(screen(rows, { ...NO_FILTERS, show: 'held' }, { favourites: new Set(), held: new Set(['DDD']) }))).toEqual(['DDD']);
  });
  it('sorts either way and always puts missing figures last', () => {
    expect(tickers(sortRows(rows, 'pe', false))).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
    expect(tickers(sortRows(rows, 'pe', true))).toEqual(['DDD', 'AAA', 'BBB', 'CCC']);
    expect(tickers(sortRows(rows, 'trades', true))).toEqual(['BBB', 'AAA', 'CCC', 'DDD']);
    expect(tickers(sortRows(rows, 'margin', true))).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
  });
});

describe('index chart', () => {
  it('folds live ticks into the same levels the server computes, keeping history', () => {
    const base = { AAA: 1000, BBB: 2000 };
    const s = fromHistory({
      ticker: 'market', range: '15m', bucketMs: 1000, span: { first: 0, last: 1000 }, sessions: [], base,
      bars: [[0, 100_000, 100_000, 100_000, 100_000, 1], [1000, 105_000, 105_000, 105_000, 105_000, 2]],
    });
    const prices = [1100, 2200];
    const level = indexLevel(Object.keys(base).map((t, i) => ({ price: prices[i], base: s.base![t] })))!;
    expect(level).toBe(110_000);
    expect(fold(s, 3, 2000, level)).toBe('append');
    expect(s.bars.map((b) => b.c)).toEqual([100_000, 105_000, 110_000]);
  });
});
