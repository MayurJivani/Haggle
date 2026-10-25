// Chart data, kept apart from the chart component so it outlives mounting and can be tested.
// History comes from the server as bars; live ticks are folded into the same bars. A tick can only
// extend the series or update its newest bar: nothing here ever removes a stored point.

import type { PriceHistory, Range } from './game';

export interface Bar {
  /** Bucket start, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Market sequence number of the bar's last price; a tick at or below it is a duplicate. */
  seq: number;
}

export interface Series {
  ticker: string;
  range: Range;
  bucketMs: number;
  bars: Bar[];
  span: PriceHistory['span'];
  sessions: PriceHistory['sessions'];
  /** Index histories only: each member's base price, to fold live ticks into the same levels. */
  base?: Record<string, number>;
}

export const fromHistory = (h: PriceHistory & { base?: Record<string, number> }): Series => ({
  ticker: h.ticker,
  range: h.range,
  bucketMs: h.bucketMs,
  bars: h.bars.map(([t, o, hi, l, c, seq]) => ({ t, o, h: hi, l, c, seq })),
  span: h.span,
  sessions: h.sessions,
  base: h.base,
});

/**
 * Folds one live price into the series. Duplicate and out-of-order ticks (seq not newer than the
 * newest bar) are ignored; a tick inside the newest bar's bucket updates that bar; a later one opens a
 * new bar. Returns what changed so the chart can draw just that.
 */
export function fold(s: Series, seq: number, at: number, price: number): 'skip' | 'update' | 'append' {
  const last = s.bars.at(-1);
  if (last && seq <= last.seq) return 'skip';
  const t = Math.floor(at / s.bucketMs) * s.bucketMs;
  if (last && t < last.t) return 'skip';
  if (last && t === last.t) {
    last.c = price;
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.seq = seq;
    return 'update';
  }
  s.bars.push({ t, o: price, h: price, l: price, c: price, seq });
  if (s.span) s.span = { first: s.span.first, last: at };
  else s.span = { first: at, last: at };
  return 'append';
}

export type LinePoint = { time: number; value: number } | { time: number };

/**
 * Points for a line series, in chart seconds. Where the market was closed (more than a few buckets
 * without a price, usually between competitions) a blank point breaks the line instead of drawing a
 * slope across hours nobody traded.
 */
export function toLine(s: Series): LinePoint[] {
  const out: LinePoint[] = [];
  const gap = s.bucketMs * 3;
  s.bars.forEach((b, i) => {
    const prev = s.bars[i - 1];
    if (prev && b.t - prev.t > gap) out.push({ time: Math.floor((prev.t + s.bucketMs) / 1000) });
    out.push({ time: Math.floor(b.t / 1000), value: b.c });
  });
  return out;
}

const RANGE_MS: Record<Range, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000, '1mo': 2_592_000_000, all: Infinity,
};
export const RANGES: Range[] = ['1m', '5m', '15m', '1h', '1d', '1w', '1mo', 'all'];
export const RANGE_LABEL: Record<Range, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '1d': '1D', '1w': '1W', '1mo': '1M', all: 'All' };

/**
 * Ranges the stored data can fill: a range is offered once there is more history than the range
 * below it shows. All is always offered.
 */
export function availableRanges(span: PriceHistory['span']): Range[] {
  const length = span ? span.last - span.first : 0;
  return RANGES.filter((r, i) => r === 'all' || i === 0 || length > RANGE_MS[RANGES[i - 1]!]);
}

/** The smallest range that holds a whole competition, so the default view shows today's round. */
export function defaultRange(competitionMs: number): Range {
  return RANGES.find((r) => RANGE_MS[r] >= competitionMs) ?? 'all';
}
