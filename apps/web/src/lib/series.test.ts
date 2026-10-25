import { describe, expect, it } from 'vitest';
import { availableRanges, defaultRange, fold, fromHistory, toLine } from './series';

const history = () =>
  fromHistory({
    ticker: 'KO', range: '15m', bucketMs: 1000,
    bars: Array.from({ length: 300 }, (_, i) => [i * 1000, 100 + i, 100 + i, 100 + i, 100 + i, i + 1] as [number, number, number, number, number, number]),
    span: { first: 0, last: 299_000 }, sessions: [],
  });

describe('chart series', () => {
  it('keeps every stored point through hundreds of live updates', () => {
    const s = history();
    const before = s.bars.map((b) => ({ ...b }));
    for (let k = 0; k < 800; k++) fold(s, 301 + k, 300_000 + k * 1000, 500 + k);
    expect(s.bars).toHaveLength(300 + 800);
    expect(s.bars.slice(0, 300)).toEqual(before);
    expect(s.bars.at(-1)!.c).toBe(1299);
  });

  it('ignores duplicate and out-of-order ticks', () => {
    const s = history();
    expect(fold(s, 300, 299_500, 1)).toBe('skip');
    expect(fold(s, 12, 400_000, 1)).toBe('skip');
    expect(s.bars).toHaveLength(300);
    expect(s.bars.at(-1)!.c).toBe(399);
  });

  it('aggregates ticks that share a bucket instead of discarding the earlier ones', () => {
    const s = { ...history(), bucketMs: 5000, bars: [] };
    expect(fold(s, 1, 10_000, 50)).toBe('append');
    expect(fold(s, 2, 11_000, 70)).toBe('update');
    expect(fold(s, 3, 12_000, 40)).toBe('update');
    expect(fold(s, 4, 15_000, 60)).toBe('append');
    expect(s.bars).toEqual([
      { t: 10_000, o: 50, h: 70, l: 40, c: 40, seq: 3 },
      { t: 15_000, o: 60, h: 60, l: 60, c: 60, seq: 4 },
    ]);
  });

  it('breaks the line across closed-market gaps rather than inventing prices', () => {
    const s = history();
    fold(s, 301, 3_600_000, 900);
    const line = toLine(s);
    expect(line).toHaveLength(302);
    expect(line[300]).toEqual({ time: 300 });
    expect(line.filter((p) => 'value' in p)).toHaveLength(301);
  });

  it('offers only the ranges the data can fill, and defaults to one competition', () => {
    expect(availableRanges({ first: 0, last: 200_000 })).toEqual(['1m', '5m', 'all']);
    expect(availableRanges(null)).toEqual(['1m', 'all']);
    expect(defaultRange(600_000)).toBe('15m');
  });
});
