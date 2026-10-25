import { describe, expect, it } from 'vitest';
import { INDEX_BASE, indexLevel, reactionBps, reactionMembers } from '../src/market/dashboard.js';

const assets = [
  { ticker: 'AAA', sector: 'Energy' },
  { ticker: 'BBB', sector: 'Energy' },
  { ticker: 'CCC', sector: 'Media' },
];

describe('index level', () => {
  it('is 1,000.00 at the base and equal-weighted above it', () => {
    expect(indexLevel([{ price: 100, base: 100 }, { price: 5000, base: 5000 }])).toBe(INDEX_BASE);
    // One member doubles, one is flat: the average ratio is 1.5 whatever the price levels.
    expect(indexLevel([{ price: 200, base: 100 }, { price: 5000, base: 5000 }])).toBe(150_000);
  });
  it('leaves out members without a price or a base', () => {
    expect(indexLevel([{ price: 110, base: 100 }, { price: undefined, base: 100 }, { price: 50, base: undefined }])).toBe(110_000);
    expect(indexLevel([])).toBeNull();
  });
});

describe('news reactions', () => {
  it('measures each story on the companies it is about', () => {
    expect(reactionMembers({ category: 'macro', target: 'rates', related: [] }, assets)).toEqual({ subject: 'market', tickers: ['AAA', 'BBB', 'CCC'] });
    expect(reactionMembers({ category: 'sector', target: 'Energy', related: [] }, assets)).toEqual({ subject: 'sector', tickers: ['AAA', 'BBB'] });
    expect(reactionMembers({ category: 'company', target: 'CCC', related: ['CCC', 'AAA', 'ZZZ'] }, assets)).toEqual({ subject: 'company', tickers: ['CCC', 'AAA'] });
    // A sector nobody is listed in falls back to the whole market rather than measuring nothing.
    expect(reactionMembers({ category: 'sector', target: 'Gone', related: [] }, assets).subject).toBe('market');
  });
  it('averages the observed moves from the tick before the story', () => {
    const before: Record<string, number> = { AAA: 1000, BBB: 2000 };
    const after: Record<string, number> = { AAA: 1100, BBB: 1900 };
    const r = reactionBps(['AAA', 'BBB', 'CCC'], (t) => before[t], (t) => after[t]);
    expect(r).toEqual({ bps: 250, moves: [{ ticker: 'AAA', bps: 1000 }, { ticker: 'BBB', bps: -500 }] });
    expect(reactionBps(['CCC'], (t) => before[t], (t) => after[t])).toBeNull();
  });
});
