// Market-wide figures for the dashboard. Everything here is derived from the shared simulated prices
// the game already holds, or fetched from the server that runs the market: nothing is invented.

import { useEffect, useState } from 'react';
import { pct } from './format';
import type { Metrics } from './research';

export interface SectorStat {
  name: string;
  n: number;
  /** Equal-weighted change since the bell, basis points. */
  bps: number;
  best: Metrics;
  worst: Metrics;
}

export interface MarketStats {
  bps: number;
  up: number;
  down: number;
  flat: number;
  sectors: SectorStat[];
  gainers: Metrics[];
  losers: Metrics[];
}

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

/** Breadth, sector averages and the biggest movers since the bell, equal-weighted like the top bar. */
export function marketStats(rows: Metrics[], movers = 5): MarketStats {
  const byBps = [...rows].sort((a, b) => b.bps - a.bps || a.asset.ticker.localeCompare(b.asset.ticker));
  const groups = new Map<string, Metrics[]>();
  for (const r of rows) groups.set(r.asset.sector, [...(groups.get(r.asset.sector) ?? []), r]);
  const sectors = [...groups].map(([name, rs]) => {
    const sorted = [...rs].sort((a, b) => b.bps - a.bps);
    return { name, n: rs.length, bps: mean(rs.map((r) => r.bps)), best: sorted[0]!, worst: sorted.at(-1)! };
  }).sort((a, b) => b.bps - a.bps);
  return {
    bps: mean(rows.map((r) => r.bps)),
    up: rows.filter((r) => r.bps > 0).length,
    down: rows.filter((r) => r.bps < 0).length,
    flat: rows.filter((r) => r.bps === 0).length,
    sectors,
    // A mover has to have moved: a flat company is neither a gainer nor a loser.
    gainers: byBps.filter((r) => r.bps > 0).slice(0, movers),
    losers: byBps.filter((r) => r.bps < 0).reverse().slice(0, movers),
  };
}

/** One plain sentence describing the session so far, read straight off the figures. */
export function summarize(s: MarketStats, regime: string): string {
  const total = s.up + s.down + s.flat;
  if (!total) return '';
  if (s.up === 0 && s.down === 0) return `All ${total} companies are where they opened. Volatility is ${regime}.`;
  const dir = s.bps > 0 ? 'up' : s.bps < 0 ? 'down' : 'flat';
  const lead = s.sectors[0]!;
  const lag = s.sectors.at(-1)!;
  const parts = [
    `The market is ${dir}${dir === 'flat' ? '' : ` ${pct(Math.abs(s.bps)).slice(1)}`} since the bell, with ${s.up} of ${total} companies rising and ${s.down} falling.`,
  ];
  if (lead.bps > 0) parts.push(`${lead.name} leads (${pct(lead.bps)}), driven by ${lead.best.asset.ticker} (${pct(lead.best.bps)}).`);
  if (lag.bps < 0 && lag !== lead) parts.push(`${lag.name} lags (${pct(lag.bps)}), weighed down by ${lag.worst.asset.ticker} (${pct(lag.worst.bps)}).`);
  parts.push(`Volatility is ${regime}.`);
  return parts.join(' ');
}

/**
 * Fetches a JSON endpoint now and every `ms` while mounted, and again whenever `again` changes. Keeps
 * the last good answer through a failed refresh, so a blip shows as stale rather than as empty.
 */
export function usePoll<T>(url: string, ms: number, again: unknown = null) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          if (!live) return;
          setData(d);
          setFailed(false);
        })
        .catch(() => live && setFailed(true));
    void load();
    const id = setInterval(load, ms);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [url, ms, again]);
  return { data, failed };
}
