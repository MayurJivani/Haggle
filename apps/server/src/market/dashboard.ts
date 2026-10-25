// Market-wide figures for the dashboard, computed from the shared simulated prices. Pure and free of
// Node imports: apps/web uses the same functions on live ticks, so a chart folded on the client and
// a chart loaded from the server land on the same numbers.

/** The index level when every member trades at its first recorded price: 1,000.00 points, in hundredths. */
export const INDEX_BASE = 100_000;

/**
 * Equal-weighted index level in hundredths of a point: the average of each member's price over its
 * first recorded price, times 1,000. Members without a base or a price are left out; none at all is null.
 */
export function indexLevel(members: readonly { price: number | undefined; base: number | undefined }[]): number | null {
  let sum = 0;
  let n = 0;
  for (const m of members) {
    if (!m.price || !m.base) continue;
    sum += m.price / m.base;
    n++;
  }
  return n ? Math.round((INDEX_BASE * sum) / n) : null;
}

/** What a story is about, for measuring the market's reaction to it. */
export interface StorySubject {
  category: 'macro' | 'sector' | 'company';
  target: string | null;
  related: string[];
}

export type ReactionSubject = 'market' | 'sector' | 'company';

/**
 * The companies a story's reaction is measured on: the whole listing for the economy, the sector's
 * members for sector news, and the companies named for company news.
 */
export function reactionMembers(ev: StorySubject, assets: readonly { ticker: string; sector: string }[]): { subject: ReactionSubject; tickers: string[] } {
  if (ev.category === 'sector' && ev.target) {
    const tickers = assets.filter((a) => a.sector === ev.target).map((a) => a.ticker);
    if (tickers.length) return { subject: 'sector', tickers };
  }
  if (ev.category === 'company') {
    const listed = new Set(assets.map((a) => a.ticker));
    const tickers = [...new Set([...(ev.target ? [ev.target] : []), ...ev.related])].filter((t) => listed.has(t));
    if (tickers.length) return { subject: 'company', tickers };
  }
  return { subject: 'market', tickers: assets.map((a) => a.ticker) };
}

const bps = (to: number, from: number) => Math.round(((to - from) * 10_000) / from);

/**
 * The observed move after a story: each member from the tick before it landed to `after`, averaged with
 * equal weights. This is what the tape did, not the story's modelled impact, which is never published.
 */
export function reactionBps(tickers: readonly string[], before: (t: string) => number | undefined, after: (t: string) => number | undefined) {
  const moves: { ticker: string; bps: number }[] = [];
  for (const t of tickers) {
    const b = before(t);
    const a = after(t);
    if (b && a) moves.push({ ticker: t, bps: bps(a, b) });
  }
  if (!moves.length) return null;
  return { bps: Math.round(moves.reduce((s, m) => s + m.bps, 0) / moves.length), moves };
}
