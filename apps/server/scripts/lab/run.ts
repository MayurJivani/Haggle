// A reproducible experiment: same seeds, same report, for any version of the engine.
//   npx tsx scripts/lab/run.ts <label> [--procs 16] [--price-seeds 200] [--seeds 2000]
// Writes docs/data/lab/<label>.json. Compare two with scripts/lab/compare.ts.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ASSETS, SECTORS } from '../../src/market/assets.js';
import { sizeLoadings } from '../../src/market/sim.js';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const label = process.argv[2] ?? 'scratch';
const PROCS = arg('procs', 16);
const PRICE_SEEDS = arg('price-seeds', 200);
const SEEDS = arg('seeds', 2000);
const q = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN;
const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

async function pool(mode: string, first: number, count: number, years: number, batch: number, onRow: (row: any) => void) {
  const jobs: string[] = [];
  for (let k = 0; k < count; k += batch) jobs.push(Array.from({ length: Math.min(batch, count - k) }, (_, j) => first + k + j).join(','));
  let done = 0;
  await Promise.all(Array.from({ length: PROCS }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      await new Promise<void>((resolve, reject) => {
        const c = spawn(process.execPath, ['--import', 'tsx', '--max-old-space-size=2500', new URL('./worker.ts', import.meta.url).pathname, mode, job!, String(years)], { stdio: ['ignore', 'pipe', 'inherit'] });
        createInterface({ input: c.stdout }).on('line', (l) => { onRow(JSON.parse(l)); done++; });
        c.on('exit', (code) => (code ? reject(new Error(`${mode} worker failed: ${code}`)) : resolve()));
      });
      process.stderr.write(`${mode} ${done}/${count}\r`);
    }
  }));
  process.stderr.write('\n');
}

const report: any = { label, generated: new Date().toISOString(), engine: process.env.ENGINE_LABEL ?? label, seeds: { prices: { first: 10_000, count: PRICE_SEEDS, years: 160 }, strategy: { first: 20_000, count: Math.round(SEEDS / 10), years: 10 }, gameplay: { first: 30_000, count: SEEDS, years: 2 } } };

// ---- price distributions
const SIZE = sizeLoadings(ASSETS);
const horizons = new Map<number, number[][][]>();
await pool('prices', 10_000, PRICE_SEEDS, 160, 2, (row) => {
  for (const h of row.horizons) { if (!horizons.has(h.h)) horizons.set(h.h, []); horizons.get(h.h)!.push(h.rows); }
});
report.prices = [...horizons].sort((a, b) => a[0] - b[0]).map(([h, runs]) => {
  const px: number[] = [], rel: number[] = [], lows: number[] = [], highs: number[] = [], dds: number[] = [];
  const perCo = ASSETS.map(() => [] as number[]);
  let floor = 0, ceil = 0, band = 0, n = 0, dd50 = 0, dd80 = 0;
  for (const rows of runs) rows.forEach((row, i) => {
    const b = Math.log(ASSETS[i]!.base);
    px.push(Math.exp(row[0]!) / 100); rel.push(Math.exp(row[0]! - b)); perCo[i]!.push(row[0]! - b);
    lows.push(Math.exp(row[1]!) / 100); highs.push(Math.exp(row[2]!) / 100); dds.push(row[3]!);
    n++;
    if (row[1]! <= Math.log(50.5)) floor++;
    if (row[2]! >= Math.log(9.9e7)) ceil++;
    if (row[2]! - b > Math.log(3) || row[1]! - b < -Math.log(3)) band++;
    if (row[3]! < Math.log(0.5)) dd50++;
    if (row[3]! < Math.log(0.2)) dd80++;
  });
  px.sort((a, b) => a - b); rel.sort((a, b) => a - b);
  const stats = (xs: number[]) => ({ min: r4(xs[0]!), p1: r4(q(xs, 0.01)), p5: r4(q(xs, 0.05)), median: r4(q(xs, 0.5)), mean: r4(mean(xs)), p95: r4(q(xs, 0.95)), p99: r4(q(xs, 0.99)), max: r4(xs.at(-1)!) });
  const medians = perCo.map((x, i) => ({ t: ASSETS[i]!.ticker, m: r4(Math.exp(q([...x].sort((a, b) => a - b), 0.5))), hi: r4(Math.exp(Math.max(...x))), lo: r4(Math.exp(Math.min(...x))) })).sort((a, b) => a.m - b.m);
  const group = (key: (i: number) => string) => {
    const g: Record<string, number[]> = {};
    perCo.forEach((x, i) => (g[key(i)] ??= []).push(...x));
    return Object.fromEntries(Object.entries(g).map(([k, v]) => { v.sort((a, b) => a - b); return [k, { p5: r4(Math.exp(q(v, 0.05))), median: r4(Math.exp(q(v, 0.5))), p95: r4(Math.exp(q(v, 0.95))) }]; }));
  };
  return {
    years: h, runs: runs.length, eur: stats(px), vsSeed: stats(rel), lowestEverEur: r4(Math.min(...lows)), highestEverEur: r4(Math.max(...highs)),
    pctHitFloor: r4(floor / n * 100), pctHitCeil: r4(ceil / n * 100), pctLeftBand: r4(band / n * 100), pctDrawdown50: r4(dd50 / n * 100), pctDrawdown80: r4(dd80 / n * 100),
    lowestCompanies: medians.slice(0, 5), highestCompanies: medians.slice(-5), bySector: group((i) => ASSETS[i]!.sector), bySize: group((i) => (SIZE[i]! > 0.4 ? 'small' : SIZE[i]! < -0.4 ? 'large' : 'mid')),
  };
});

// ---- strategies and the anchor
const buckets = new Map<string, any[]>();
const anchor = new Map<string, number[][]>();
await pool('strategy', 20_000, Math.round(SEEDS / 10), 10, 2, (row) => {
  for (const [s, h, u, b, x, ret, dd, reg] of row.samples) {
    const k = `${s}|${h}|${u}|${b}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push([x, ret, dd, reg]);
  }
  for (const [kind, bk, h, ret, x, rec, low] of row.anchor) {
    const k = `${kind}|${bk}|${h}`;
    if (!anchor.has(k)) anchor.set(k, []);
    anchor.get(k)!.push([ret, x, rec, low]);
  }
});
report.strategies = [...buckets].map(([k, rows]) => {
  const [s, h, u, b] = k.split('|');
  const xs = rows.map((r) => r[0] as number).sort((a, c) => a - c);
  const ret = rows.map((r) => r[1] as number).sort((a, c) => a - c);
  const regimes: Record<string, unknown> = {};
  for (const reg of ['bull', 'bear', 'recession', 'crisis']) {
    const m = rows.filter((r) => r[3] === reg).map((r) => r[0] as number);
    regimes[reg] = { n: m.length, mean: r4(mean(m)), win: r4(m.filter((x) => x > 0).length / Math.max(1, m.length)) };
  }
  return {
    strategy: s, holdRounds: +h!, universe: u, budget: +b! / 100, n: rows.length, meanExcess: r4(mean(xs)), medianExcess: r4(q(xs, 0.5)), winVsMarket: r4(xs.filter((x) => x > 0).length / xs.length),
    meanReturn: r4(mean(ret)), medianReturn: r4(q(ret, 0.5)), winAbsolute: r4(ret.filter((x) => x > 0).length / ret.length), worst5: r4(q(ret, 0.05)), best5: r4(q(ret, 0.95)),
    meanDrawdown: r4(mean(rows.map((r) => r[2] as number))), sharpe: r4(mean(ret) / (sd(ret) || 1)), excessT: r4(mean(xs) / (sd(xs) / Math.sqrt(xs.length) || 1)), regimes,
  };
}).sort((a, b) => a.holdRounds - b.holdRounds || b.meanExcess - a.meanExcess);
const NAMES = ['above fair', '0-10%', '10-25%', '25-50%', '50-100%', 'over 100%'];
report.anchor = [...anchor].map(([k, rows]) => {
  const [kind, bk, h] = k.split('|');
  const ret = rows.map((r) => r[0]!).sort((a, c) => a - c);
  return { kind, discount: NAMES[+bk! + 1], holdRounds: +h!, n: rows.length, meanLog: r4(mean(ret)), medianLog: r4(q(ret, 0.5)), pUp: r4(ret.filter((x) => x > 0).length / ret.length), meanExcess: r4(mean(rows.map((r) => r[1]!))), pExcess: r4(rows.filter((r) => r[1]! > 0).length / rows.length), recovered: r4(mean(rows.map((r) => r[2]!))), meanWorstDip: r4(mean(rows.map((r) => r[3]!))), worst5: r4(q(ret, 0.05)) };
}).sort((a, b) => a.kind!.localeCompare(b.kind!) || a.holdRounds - b.holdRounds || NAMES.indexOf(a.discount!) - NAMES.indexOf(b.discount!));

// ---- gameplay
const rounds: any[] = [];
await pool('gameplay', 30_000, SEEDS, 2, 20, (row) => rounds.push(...row.rounds));
const avg = (f: (r: any) => number) => r4(mean(rounds.map(f)));
const names = Object.keys(rounds[0].ret);
report.gameplay = {
  rounds: rounds.length, leadChanges: avg((r) => r.leadChanges), closeFinish: avg((r) => r.closeFinish), earlyLeaderWins: avg((r) => r.earlyLock), comeback: avg((r) => r.comeback),
  longestFreezeDays: avg((r) => r.longestFreeze), spread: avg((r) => r.spread), bestBot: avg((r) => r.best), worstBot: avg((r) => r.worst), bigDailyMoves: avg((r) => r.bigMoves), bigCompanies: avg((r) => r.bigCompanies), bigSectors: avg((r) => r.bigSectors),
  stories: avg((r) => r.stories), severeStories: avg((r) => r.severe), longestQuietDays: avg((r) => r.longestQuiet), quietOver20Days: avg((r) => (r.longestQuiet > 20 ? 1 : 0)), storiesByThird: [0, 1, 2].map((k) => avg((r) => r.storyThirds[k])),
  marketMoveAbs: avg((r) => Math.abs(r.marketMove)), dullRounds: avg((r) => (r.bigCompanies < 3 && r.bigSectors === 0 ? 1 : 0)),
  bots: names.map((n) => { const x = rounds.map((r) => r.ret[n] as number).sort((a, b) => a - b); return { bot: n, winShare: r4(rounds.filter((r) => r.winner === n).length / rounds.length), mean: r4(mean(x)), median: r4(q(x, 0.5)), worst5: r4(q(x, 0.05)), best5: r4(q(x, 0.95)) }; }),
};
mkdirSync(new URL('../../../../docs/data/lab/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../../../../docs/data/lab/${label}.json`, import.meta.url), `${JSON.stringify(report, null, 1)}\n`);
console.log(`wrote docs/data/lab/${label}.json`, SECTORS.length);
