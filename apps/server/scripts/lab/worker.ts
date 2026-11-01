// One seed of an experiment: writes its summaries as one JSON line. Run through scripts/lab/run.ts.
import { ASSETS } from '../../src/market/assets.js';
import { SIM } from '../../src/market/sim.js';
import { simulate } from '../calibration/simulate.js';
import { anchorStudy, backtest } from './strategies.js';
import { playRound } from './gameplay.js';

// An experiment overrides parameters without touching the code: LAB_SET='{"reversion":0.002}'.
Object.assign(SIM, JSON.parse(process.env.LAB_SET ?? '{}'));
const [mode, seedsArg, yearsArg] = process.argv.slice(2);
const years = Number(yearsArg);
const core = ASSETS.flatMap((a, i) => (a.core ? [i] : []));
const all = ASSETS.map((_, i) => i);
const HORIZONS = [10, 25, 50, 100, 160].filter((h) => h <= years);

for (const seed of seedsArg!.split(',').map(Number)) {
  const run = simulate(seed, years);
  let out: unknown;
  if (mode === 'prices') {
    out = {
      seed,
      horizons: HORIZONS.map((h) => {
        const end = Math.min(run.days, h * 252) - 1;
        return { h, rows: run.logP.map((lp) => {
          let min = Infinity, max = -Infinity, peak = -Infinity, dd = 0;
          for (let d = 0; d <= end; d++) { const l = lp[d]!; if (l < min) min = l; if (l > max) max = l; if (l > peak) peak = l; dd = Math.min(dd, l - peak); }
          return [+lp[end]!.toFixed(3), +min.toFixed(3), +max.toFixed(3), +dd.toFixed(3)];
        }) };
      }),
    };
  } else if (mode === 'strategy') {
    const rnd = (k: number) => { const p = [...all].sort((a, b) => ((a * 2654435761 ^ seed) >>> 0) - ((b * 2654435761 ^ seed) >>> 0)); return p.slice(0, k); };
    const samples = backtest(run, seed, { core, all, room20: rnd(20) }, [1_000_000]);
    const budget = backtest(run, seed, { core }, [100_000]);
    out = { seed, samples: [...samples, ...budget].map((s) => [s.s, s.h, s.u, s.b, +s.x.toFixed(4), +s.ret.toFixed(4), +s.dd.toFixed(4), s.reg]), anchor: anchorStudy(run).map((a) => [a.kind, a.bucket, a.h, +a.ret.toFixed(4), +a.x.toFixed(4), a.recovered, +a.low.toFixed(4)]) };
  } else {
    out = { seed, rounds: run.rounds.map((_, r) => playRound(run, r, core, seed)).filter(Boolean) };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
