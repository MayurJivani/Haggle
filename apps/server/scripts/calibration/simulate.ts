// Runs the market model for many simulated years the way the game does (a competition of scheduled
// news every 600 ticks, reports filed by earnings stories) and records what the history script
// measures, so the two can be compared. Used by run-sim.ts and by test/calibration.test.ts.
import { ASSETS, SECTORS } from '../../src/market/assets.js';
import { quietReports, schedule, type Context } from '../../src/market/events.js';
import { seedReports, sharesOf, summarize, type Report } from '../../src/market/fundamentals.js';
import { DAYS_PER_TICK, initialState, MarketSim, type SimNote } from '../../src/market/sim.js';
import { acf, corr, drawdowns, kurtosis, mean, sd, skew } from './stats.js';

const TICKS_PER_DAY = Math.round(1 / DAYS_PER_TICK);
const COMPETITION = 600;

export interface Run {
  days: number;
  /** Per simulated day: the sector-balanced market log return (what calibration compares), the listing's cap-weighted one, each sector's, and every company's log price. */
  market: Float64Array;
  capWeighted: Float64Array;
  sectors: Float64Array[];
  logP: Float32Array[];
  variance: Float64Array;
  recession: Uint8Array;
  credit: Float64Array;
  notes: SimNote[];
  /** Scheduled stories: the day they landed, their target company (or -1), and the sign of their move. */
  stories: { day: number; asset: number; sign: number }[];
}

export function simulate(seed: number, years: number, news = true): Run {
  const fairs = ASSETS.map((a) => summarize(a, seedReports(a)).fair?.cents ?? a.base);
  const sim = new MarketSim(ASSETS, initialState(ASSETS, seed, fairs), fairs);
  const reports = ASSETS.map((a) => seedReports(a));
  const shares = ASSETS.map((a) => sharesOf(a));
  const days = Math.floor((years * 252) / 1);
  const run: Run = {
    days, market: new Float64Array(days), capWeighted: new Float64Array(days), sectors: SECTORS.map(() => new Float64Array(days)), logP: ASSETS.map(() => new Float32Array(days)),
    variance: new Float64Array(days), recession: new Uint8Array(days), credit: new Float64Array(days), notes: [], stories: [],
  };
  let id = 1;
  let prev = Array.from(sim.prices, (p) => Math.log(p));
  for (let d = 0; d < days; d++) {
    const mk = new Float64Array(1);
    let broad = 0;
    for (let k = 0; k < TICKS_PER_DAY; k++) {
      if (news && sim.seq % COMPETITION === 0) {
        const ctx: Context = {
          assets: ASSETS, reports: (i) => reports[i]!, ticksPerSecond: 1, maxTick: COMPETITION, at: (t) => t * 1000,
          value: (i) => sim.value(i),
        };
        const stories = schedule((seed * 7919 + sim.seq) >>> 0, ctx, COMPETITION);
        // Every other company files its quarter quietly during the competition, as the engine does.
        const storied = new Set(stories.flatMap((e) => (e.report ? [e.effects[0]!.asset] : [])));
        const evs = [...stories, ...quietReports((seed * 31 + sim.seq) >>> 0, ctx, storied, COMPETITION)];
        sim.load(evs.map((e) => ({
          id: id++, seq: sim.seq + e.tick, duration: e.duration, jump: e.jump, persistence: e.persistence, severity: e.severity, effects: e.effects,
          report: e.report,
        })));
      }
      const fired = sim.step() as (ReturnType<MarketSim['step']>[number] & { report?: Report })[];
      for (const ev of fired) {
        if (ev.effects.length === 1) run.stories.push({ day: d, asset: ev.effects[0]!.asset, sign: Math.sign(ev.effects[0]!.pct) });
        if (ev.report) {
          const i = ASSETS.findIndex((a) => a.ticker === ev.report!.ticker);
          reports[i]!.push(ev.report);
          const fair = summarize(ASSETS[i]!, reports[i]!).fair;
          if (fair) sim.setFair(i, fair.cents);
        }
      }
      run.notes.push(...sim.notes);
      // Cap-weighted market and sector returns at the caps of the tick before.
      const now = Array.from(sim.prices, (p) => Math.log(p));
      const caps = prev.map((l, i) => Math.exp(l) * shares[i]!);
      let total = 0;
      let wsum = 0;
      const secR = SECTORS.map(() => 0);
      const secW = SECTORS.map(() => 0);
      // Portfolio returns: the log of the cap-weighted simple return, not a weighted mean of log returns
      // (which overstates growth by about half the average stock variance).
      ASSETS.forEach((a, i) => {
        const r = Math.expm1(now[i]! - prev[i]!);
        total += caps[i]! * r;
        wsum += caps[i]!;
        const s = SECTORS.indexOf(a.sector);
        secR[s]! += caps[i]! * r;
        secW[s]! += caps[i]!;
      });
      mk[0]! += Math.log1p(total / wsum);
      // The listing's cap-weighted index is concentrated (six companies are half of it); the broad market
      // the history is measured on is closer to the sectors weighted equally.
      broad += Math.log1p(SECTORS.reduce((t, _, s) => t + secR[s]! / secW[s]!, 0) / SECTORS.length);
      SECTORS.forEach((_, s) => (run.sectors[s]![d]! += Math.log1p(secR[s]! / secW[s]!)));
      prev = now;
    }
    run.capWeighted[d] = mk[0]!;
    run.market[d] = broad;
    ASSETS.forEach((_, i) => (run.logP[i]![d] = prev[i]!));
    run.variance[d] = sim.variance;
    run.recession[d] = sim.recession ? 1 : 0;
    run.credit[d] = sim.credit;
  }
  return run;
}

/**
 * Independent episodes from a fresh market, stitched end to end into one long record, so rare events
 * (recessions, crashes) are pooled rather than averaged episode by episode.
 */
export function simulateEpisodes(firstSeed: number, episodes: number, years: number): Run {
  const runs = Array.from({ length: episodes }, (_, k) => simulate(firstSeed + k, years));
  const cat = <T extends Float64Array | Float32Array | Uint8Array>(xs: T[]): T => {
    const out = new (xs[0]!.constructor as new (n: number) => T)(xs.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of xs) {
      out.set(x as never, at);
      at += x.length;
    }
    return out;
  };
  let offset = 0;
  const notes = runs.flatMap((r) => {
    const shifted = r.notes.map((n) => ({ ...n, seq: n.seq + offset * TICKS_PER_DAY }));
    offset += r.days;
    return shifted;
  });
  return {
    days: runs.reduce((n, r) => n + r.days, 0),
    market: cat(runs.map((r) => r.market)),
    capWeighted: cat(runs.map((r) => r.capWeighted)),
    sectors: SECTORS.map((_, k) => cat(runs.map((r) => r.sectors[k]!))),
    // Prices restart at the seed each episode; a stitched log price would jump at the seams, so each
    // episode's prices continue from where the last one ended.
    logP: ASSETS.map((_, i) => {
      const parts = runs.map((r) => r.logP[i]!);
      const out = new Float32Array(parts.reduce((n, x) => n + x.length, 0));
      let at = 0;
      let shift = 0;
      parts.forEach((x, k) => {
        if (k > 0) shift = out[at - 1]! - x[0]!;
        for (let d = 0; d < x.length; d++) out[at + d] = x[d]! + shift;
        at += x.length;
      });
      return out;
    }),
    variance: cat(runs.map((r) => r.variance)),
    recession: cat(runs.map((r) => r.recession)),
    credit: cat(runs.map((r) => r.credit)),
    notes,
    stories: runs.flatMap((r) => r.stories),
  };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** The same statistics measure-history.ts reports, from a simulated run. */
export function measure(run: Run) {
  const r = Array.from(run.market);
  const z = sd(r);
  const lv = (x: Float64Array) => {
    let s = 0;
    return Array.from(x, (v, d) => ({ date: String(d), lv: (s += v) }));
  };
  const dd = drawdowns(lv(run.market), 0.25);
  const years = run.days / 252;

  // Sectors: correlation in calm and stressed days.
  const pairCorr = (days: number[]) => {
    const cs: number[] = [];
    for (let a = 0; a < SECTORS.length; a++) for (let b = a + 1; b < SECTORS.length; b++) {
      cs.push(corr(days.map((d) => run.sectors[a]![d]!), days.map((d) => run.sectors[b]![d]!)));
    }
    return r4(mean(cs));
  };
  const all = [...Array(run.days).keys()];
  const calm = all.filter((d) => run.variance[d]! < 1.2);
  const stressed = all.filter((d) => run.variance[d]! > 3);

  // Monthly (21-day) series for size, momentum and industry momentum.
  const M = 21;
  const months = Math.floor(run.days / M);
  const at = (i: number, m: number) => run.logP[i]![m * M + M - 1]!;
  const mktM = Array.from({ length: months }, (_, m) => r.slice(m * M, m * M + M).reduce((s, x) => s + x, 0));

  const caps = ASSETS.map((a) => Math.log(sharesOf(a) * a.base));
  const order = [...caps.keys()].sort((a, b) => caps[a]! - caps[b]!);
  const third = Math.floor(order.length / 3);
  const small = order.slice(0, third);
  const big = order.slice(-third);
  const groupM = (g: number[]) => Array.from({ length: months - 1 }, (_, m) => mean(g.map((i) => at(i, m + 1) - at(i, m))));
  const beta = (y: number[]) => r4((corr(mktM.slice(1), y) * sd(y)) / sd(mktM.slice(1)));

  // Stock momentum: past 12 months skipping the last one, top 30% minus bottom 30%, next month.
  const wml: number[] = [];
  for (let m = 12; m + 1 < months; m++) {
    const ranked = ASSETS.map((_, i) => ({ past: at(i, m - 1) - at(i, m - 12), next: at(i, m + 1) - at(i, m) })).sort((a, b) => b.past - a.past);
    const n = Math.floor(ranked.length * 0.3);
    wml.push(mean(ranked.slice(0, n).map((x) => x.next)) - mean(ranked.slice(-n).map((x) => x.next)));
  }

  // Industry momentum, as measured on the 12 US industries.
  const secM = run.sectors.map((s) => Array.from({ length: months }, (_, m) => s.slice(m * M, m * M + M).reduce((a, x) => a + x, 0)));
  const pastRel: number[] = [];
  const nextRel: number[] = [];
  const spread: number[] = [];
  for (let m = 12; m + 1 < months; m++) {
    const past12 = (k: number) => secM[k]!.slice(m - 12, m).reduce((a, x) => a + x, 0) - mktM.slice(m - 12, m).reduce((a, x) => a + x, 0);
    const ranked = SECTORS.map((_, k) => ({ past: past12(k), next: secM[k]![m]! - mktM[m]! })).sort((a, b) => b.past - a.past);
    for (const x of ranked) {
      pastRel.push(x.past);
      nextRel.push(x.next);
    }
    spread.push(mean(ranked.slice(0, 3).map((x) => x.next)) - mean(ranked.slice(-3).map((x) => x.next)));
  }

  // Run-ups and crashes: a sector up 100% over two years, then down 40% within the next two.
  const Y2 = 504;
  let runups = 0;
  let runupCrashes = 0;
  let base = 0;
  let baseCrashes = 0;
  for (const s of run.sectors) {
    let acc = 0;
    const lvl = Array.from(s, (x) => (acc += x));
    for (let d = Y2; d + Y2 < run.days; d += M) {
      let min = Infinity;
      for (let e = d + 1; e <= d + Y2; e++) min = Math.min(min, lvl[e]!);
      const crashed = Math.exp(min - lvl[d]!) - 1 <= -0.4;
      base++;
      if (crashed) baseCrashes++;
      if (Math.exp(lvl[d]! - lvl[d - Y2]!) - 1 > 1) {
        runups++;
        if (crashed) runupCrashes++;
      }
    }
  }

  // The headline trade: buy a company at the close of the day a positive story about it landed (the
  // move is already in), hold for about a fifth of a competition (12 days) or a whole one (60).
  const headline = (hold: number) => {
    const rs = run.stories.filter((x) => x.sign > 0 && x.asset >= 0 && x.day + hold < run.days)
      .map((x) => run.logP[x.asset]![x.day + hold]! - run.logP[x.asset]![x.day]! - (run.market.slice(x.day + 1, x.day + hold + 1).reduce((t, v) => t + v, 0)));
    return { trades: rs.length, winRate: r4(rs.filter((x) => x > 0).length / rs.length), meanExcess: r4(mean(rs)) };
  };

  const inRec = all.filter((d) => run.recession[d]);
  const outRec = all.filter((d) => !run.recession[d]);
  return {
    years: r4(years),
    market: {
      dailySd: r4(z),
      annualSd: r4(z * Math.sqrt(252)),
      annualMean: r4(mean(r) * 252),
      skew: r4(skew(r)),
      excessKurtosis: r4(kurtosis(r) - 3),
      acfReturnLag1: r4(acf(r, 1)),
      acfAbsLag: Object.fromEntries([1, 5, 20, 60, 120].map((k) => [k, r4(acf(r.map(Math.abs), k))])),
      leverageEffect: r4(corr(r.slice(0, -1), r.slice(1).map((x) => x * x))),
      shareBeyond3Sd: r4(r.filter((x) => Math.abs(x - mean(r)) > 3 * z).length / r.length),
      shareBeyond5Sd: r4(r.filter((x) => Math.abs(x - mean(r)) > 5 * z).length / r.length),
    },
    drawdowns: {
      per100YearsOver25: r4((dd.length / years) * 100),
      per100YearsOver40: r4((dd.filter((x) => x.depth <= -0.4).length / years) * 100),
      deepest: dd.slice(0, 3),
    },
    cycle: {
      recessionShareOfDays: r4(inRec.length / run.days),
      annualMeanInRecession: r4(mean(inRec.map((d) => r[d]!)) * 252),
      annualMeanOutsideRecession: r4(mean(outRec.map((d) => r[d]!)) * 252),
      annualSdInRecession: r4(sd(inRec.map((d) => r[d]!)) * Math.sqrt(252)),
      annualSdOutsideRecession: r4(sd(outRec.map((d) => r[d]!)) * Math.sqrt(252)),
    },
    sectors: {
      avgPairwiseCorr: pairCorr(all),
      avgPairwiseCorrCalm: calm.length > 100 ? pairCorr(calm) : null,
      avgPairwiseCorrStressed: stressed.length > 100 ? pairCorr(stressed) : null,
    },
    size: {
      monthlyAnnualSdSmallThird: r4(sd(groupM(small)) * Math.sqrt(12)),
      monthlyAnnualSdBigThird: r4(sd(groupM(big)) * Math.sqrt(12)),
      monthlyBetaSmallThird: beta(groupM(small)),
      monthlyBetaBigThird: beta(groupM(big)),
    },
    momentum: {
      annualMean: r4(mean(wml) * 12),
      annualSd: r4(sd(wml) * Math.sqrt(12)),
      skew: r4(skew(wml)),
    },
    industryMomentum: {
      past12mRelVsNextMonthRelCorr: r4(corr(pastRel, nextRel)),
      top3MinusBottom3MonthlyMean: r4(mean(spread)),
      shareOfMonthsPositive: r4(spread.filter((x) => x > 0).length / spread.length),
    },
    runups: { sectorMonths: base, baseRateCrash: r4(baseCrashes / base), runupMonths: runups, crashGivenRunup: runups ? r4(runupCrashes / runups) : null },
    notes: Object.fromEntries(['sector-crash', 'panic', 'recession', 'credit-tight'].map((k) => [k, r4(run.notes.filter((n) => n.kind === k).length / years)])),
    credit: { mean: r4(mean(Array.from(run.credit))), max: r4(Math.max(...run.credit)) },
    headlineTrade: { hold12Days: headline(12), hold60Days: headline(60) },
  };
}
