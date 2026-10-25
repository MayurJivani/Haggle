import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/market/assets.js';
import { fairValue, nextReport, peRatio, SEED_QUARTERS, seedReports, summarize } from '../src/market/fundamentals.js';

const asset = (t: string) => ASSETS.find((a) => a.ticker === t)!;

describe('simulated financials', () => {
  it('seeds twelve consecutive quarters per company, the same on every run', () => {
    for (const a of ASSETS) {
      const r = seedReports(a);
      expect(r).toHaveLength(SEED_QUARTERS);
      expect(seedReports(a)).toEqual(r);
      r.forEach((q, i) => i && expect(q.fiscalYear * 4 + q.fiscalQuarter).toBe(r[i - 1]!.fiscalYear * 4 + r[i - 1]!.fiscalQuarter + 1));
      expect(r.every((q) => q.source === 'simulated' && q.revenue > 0)).toBe(true);
    }
  });

  it('trailing EPS sums the last four quarters, and refuses to guess when one is missing', () => {
    const r = seedReports(asset('SAP'));
    const s = summarize(asset('SAP'), r);
    expect(s.epsTtm).toBeCloseTo(r.slice(-4).reduce((x, q) => x + q.eps, 0), 3);
    const gap = r.filter((_, i) => i !== r.length - 2);
    expect(summarize(asset('SAP'), gap).epsTtm).toBeNull();
    expect(summarize(asset('SAP'), gap).fair).toBeNull();
    expect(summarize(asset('SAP'), []).epsTtm).toBeNull();
  });

  it('P/E handles negative, zero, missing and very large earnings', () => {
    expect(peRatio(10_000, 2)).toBe(50);
    expect(peRatio(10_000, -1.2)).toBe('N/M');
    expect(peRatio(10_000, 0)).toBe('N/M');
    expect(peRatio(10_000, null)).toBe('N/A');
    expect(peRatio(10_000_000, 0.0001)).toBe(1_000_000_000);
  });

  it('a loss-maker is valued on sales, a profitable company on earnings', () => {
    expect(summarize(asset('BA'), seedReports(asset('BA'))).fair!.basis).toBe('sales');
    expect(summarize(asset('KO'), seedReports(asset('KO'))).fair!.basis).toBe('earnings');
  });

  it('strong earnings do not make a stock cheap: some profitable companies seed well above fair value', () => {
    const rich = ASSETS.filter((a) => {
      const s = summarize(a, seedReports(a));
      return s.epsTtm! > 0 && s.epsGrowth! > 0 && a.base > s.fair!.cents * 1.5;
    });
    expect(rich.length).toBeGreaterThan(0);
  });

  it('fair value is a function of the reports alone, never of the price', () => {
    const a = asset('NVDA');
    const s = summarize(a, seedReports(a));
    expect(fairValue({ ...a, base: a.base * 10 }, s)).toEqual(s.fair);
  });

  it('a beat files a quarter above estimate and lifts trailing EPS', () => {
    const a = asset('MSFT');
    const r = seedReports(a);
    const next = nextReport(a, r, 0.1, 0.02, Date.UTC(2026, 9, 25));
    expect(next.eps).toBeGreaterThan(next.epsEstimate!);
    expect([next.fiscalYear, next.fiscalQuarter]).toEqual([2026, 3]);
    expect(summarize(a, [...r, next]).epsTtm!).toBeGreaterThan(summarize(a, r).epsTtm!);
  });
});
