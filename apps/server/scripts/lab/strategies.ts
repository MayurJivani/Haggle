// Mechanical strategies run over a recorded market, using only what a player can see at the moment of
// deciding: prices, published news, reports. Each picks companies at a round's start and holds.
import { ASSETS, SECTORS } from '../../src/market/assets.js';
import { rng } from '../../src/market/rng.js';
import { sizeLoadings } from '../../src/market/sim.js';
import type { Run } from '../calibration/simulate.js';

export const ROUND_DAYS = 60;
const SIZE = sizeLoadings(ASSETS);
const SECTOR = ASSETS.map((a) => SECTORS.indexOf(a.sector));

export interface View { run: Run; d: number; r: number; pool: number[]; next: () => number }
type Picker = (v: View) => number[];

const past = (v: View, i: number, days: number) => v.run.logP[i]![v.d]! - v.run.logP[i]![Math.max(0, v.d - days)]!;
const top = (v: View, score: (i: number) => number, k = 5) =>
  v.pool.map((i) => [i, score(i)] as const).filter(([, s]) => Number.isFinite(s)).sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
const newsSince = (v: View, days: number) => v.run.news.filter((n) => n.day > v.d - days && n.day <= v.d);
const companyNews = (v: View, sign: number) => {
  const hits = newsSince(v, ROUND_DAYS).filter((n) => n.scope === 'asset' && n.sign === sign).flatMap((n) => n.assets).filter((i) => v.pool.includes(i));
  return [...new Set(hits)].slice(-5);
};
const sectorReturns = (v: View, days: number) => SECTORS.map((_, k) => {
  const m = v.pool.filter((i) => SECTOR[i] === k);
  return m.length ? m.reduce((t, i) => t + past(v, i, days), 0) / m.length : NaN;
});
const marketPast = (v: View, days: number) => v.pool.reduce((t, i) => t + past(v, i, days), 0) / v.pool.length;
const fair = (v: View, i: number) => v.run.rounds[v.r]!.fair[i]! - v.run.logP[i]![v.d]!;
const growth = (v: View, i: number) => v.run.rounds[v.r]!.growth[i]!;
const inSector = (v: View, k: number) => v.pool.filter((i) => SECTOR[i] === k);
const shuffled = (v: View, k: number) => [...v.pool].map((i) => [v.next(), i] as const).sort((a, b) => a[0] - b[0]).slice(0, k).map(([, i]) => i);

export const STRATEGIES: Record<string, Picker> = {
  'biggest losers': (v) => top(v, (i) => -past(v, i, ROUND_DAYS)),
  'recent winners': (v) => top(v, (i) => past(v, i, ROUND_DAYS)),
  'below fair value': (v) => top(v, (i) => fair(v, i)),
  'deep discount (>40%)': (v) => top(v, (i) => (fair(v, i) > Math.log(1 / 0.6) ? fair(v, i) : NaN)),
  'after bad company news': (v) => companyNews(v, -1),
  'after good company news': (v) => companyNews(v, 1),
  'improving earnings': (v) => top(v, (i) => growth(v, i)),
  'deteriorating earnings': (v) => top(v, (i) => -growth(v, i)),
  'sector rotation': (v) => { const s = sectorReturns(v, ROUND_DAYS); const k = s.indexOf(Math.max(...s.filter(Number.isFinite))); return inSector(v, k); },
  'defensive': (v) => top(v, (i) => -ASSETS[i]!.beta - ASSETS[i]!.vol * 100, 8),
  'high growth': (v) => top(v, (i) => ASSETS[i]!.growth),
  'small companies': (v) => top(v, (i) => SIZE[i]!),
  'after market crash': (v) => (marketPast(v, ROUND_DAYS) < -0.1 ? top(v, (i) => ASSETS[i]!.beta) : []),
  'after sector decline': (v) => { const s = sectorReturns(v, ROUND_DAYS); const k = s.indexOf(Math.min(...s.filter(Number.isFinite))); return s[k]! < -0.08 ? inSector(v, k) : []; },
  'random five': (v) => shuffled(v, 5),
  'equal weight': (v) => v.pool,
  'concentrated (one random)': (v) => shuffled(v, 1),
  'momentum + reversal': (v) => top(v, (i) => past(v, i, 240) - past(v, i, 20)),
};

export const HOLDS = [1, 5, 10];

/** Whole-share portfolio value after holding `picks` from day d to e, per EUR 1 of budget; cash stays cash. */
export function held(run: Run, picks: number[], d: number, e: number, budgetCents: number) {
  const each = budgetCents / Math.max(1, picks.length);
  let value = budgetCents;
  let low = budgetCents;
  const lots = picks.map((i) => {
    const p = Math.round(Math.exp(run.logP[i]![d]!));
    const q = Math.floor(each / p);
    value -= q * p;
    return { i, q };
  });
  const cash = value;
  let end = cash;
  for (let t = d; t <= e; t += 5) {
    let v = cash;
    for (const { i, q } of lots) v += q * Math.round(Math.exp(run.logP[i]![t]!));
    low = Math.min(low, v);
    end = v;
  }
  return { ret: end / budgetCents - 1, drawdown: low / budgetCents - 1, invested: 1 - cash / budgetCents };
}

export function regimeAt(run: Run, d: number): 'crisis' | 'recession' | 'bull' | 'bear' {
  if (run.variance[d]! >= 3) return 'crisis';
  if (run.recession[d]) return 'recession';
  let y = 0;
  for (let t = Math.max(0, d - 120); t < d; t++) y += run.market[t]!;
  return y >= 0 ? 'bull' : 'bear';
}

export interface Sample { s: string; h: number; u: string; b: number; x: number; ret: number; dd: number; reg: string }

/** Every strategy, every hold, on every round of a run. Excess is over the equal-weighted pool. */
export function backtest(run: Run, seed: number, pools: Record<string, number[]>, budgets: number[]): Sample[] {
  const out: Sample[] = [];
  const next = rng(seed ^ 0xabc123);
  run.rounds.forEach((round, r) => {
    const d = round.day;
    if (r < 4) return;
    for (const h of HOLDS) {
      const e = d + h * ROUND_DAYS;
      if (e >= run.days) continue;
      for (const [u, pool] of Object.entries(pools)) {
        const v: View = { run, d, r, pool, next };
        for (const b of budgets) {
          const base = held(run, pool, d, e, 100_000_000).ret;
          for (const [s, pick] of Object.entries(STRATEGIES)) {
            const picks = pick(v);
            if (!picks.length) continue;
            const h2 = held(run, picks, d, e, b);
            out.push({ s, h, u, b, x: h2.ret - base, ret: h2.ret, dd: h2.drawdown, reg: regimeAt(run, d) });
          }
        }
      }
    }
  });
  return out;
}

export interface AnchorRow { kind: 'fair' | 'anchor'; bucket: number; h: number; ret: number; x: number; recovered: number; low: number }

/** What buying at a discount pays: by distance below public fair value and below the hidden anchor. */
export function anchorStudy(run: Run): AnchorRow[] {
  const out: AnchorRow[] = [];
  const bucket = (g: number) => (g < 0 ? -1 : g < 0.1 ? 0 : g < 0.25 ? 1 : g < 0.5 ? 2 : g < 1 ? 3 : 4);
  run.rounds.forEach((round, r) => {
    if (r < 4 || r % 2) return;
    const d = round.day;
    for (const h of HOLDS) {
      const e = d + h * ROUND_DAYS;
      if (e >= run.days) continue;
      let mkt = 0;
      for (let i = 0; i < ASSETS.length; i++) mkt += (run.logP[i]![e]! - run.logP[i]![d]!) / ASSETS.length;
      for (let i = 0; i < ASSETS.length; i++) {
        const lp = run.logP[i]!;
        let low = 0;
        for (let t = d; t <= e; t += 5) low = Math.min(low, lp[t]! - lp[d]!);
        const ret = lp[e]! - lp[d]!;
        const f = round.fair[i]! - lp[d]!;
        if (Number.isFinite(f)) out.push({ kind: 'fair', bucket: bucket(f), h, ret, x: ret - mkt, recovered: ret >= Math.min(f, 0.25) ? 1 : 0, low });
        const g = round.gap[i]!;
        out.push({ kind: 'anchor', bucket: bucket(g), h, ret, x: ret - mkt, recovered: ret >= Math.min(g, 0.25) ? 1 : 0, low });
      }
    }
  });
  return out;
}
