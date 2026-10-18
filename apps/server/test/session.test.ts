import { describe, expect, it } from 'vitest';
import { compareRank, phaseAt, sharpe } from '../src/session/ranking.js';

describe('session phases', () => {
  const open = 10_000;
  const close = 70_000;
  it('walks lobby, trading, closing, results', () => {
    expect(phaseAt(0, open, close, 10, false)).toBe('lobby');
    expect(phaseAt(open, open, close, 10, false)).toBe('trading');
    expect(phaseAt(close - 10_001, open, close, 10, false)).toBe('trading');
    expect(phaseAt(close - 10_000, open, close, 10, false)).toBe('closing');
    expect(phaseAt(close, open, close, 10, false)).toBe('results');
    expect(phaseAt(open, open, close, 10, true)).toBe('results');
  });
});

describe('ranking', () => {
  it('orders by value, then join time, then nickname', () => {
    const rows = [
      { nickname: 'b', joinedAt: 2, value: 100 },
      { nickname: 'a', joinedAt: 2, value: 100 },
      { nickname: 'z', joinedAt: 1, value: 100 },
      { nickname: 'top', joinedAt: 9, value: 101 },
    ];
    expect(rows.sort(compareRank).map((r) => r.nickname)).toEqual(['top', 'z', 'a', 'b']);
  });

  it('sharpe needs movement and enough samples', () => {
    expect(sharpe([100, 100, 100, 100, 100, 100])).toBeNull();
    expect(sharpe([100, 101])).toBeNull();
    const steady = sharpe([100, 101, 102, 103, 104, 105, 106])!;
    const choppy = sharpe([100, 110, 95, 112, 90, 115, 106])!;
    expect(steady).toBeGreaterThan(choppy);
  });
});
