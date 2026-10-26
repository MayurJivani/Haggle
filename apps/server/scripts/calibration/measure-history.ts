// Measures the stylized facts the market model is calibrated against, from the public series that
// fetch-history.sh downloads. Writes docs/data/history-stats.json; every historical number quoted in
// docs/ comes from this file or from a cited paper, never from memory.
//
//   sh scripts/calibration/fetch-history.sh .history && npx tsx scripts/calibration/measure-history.ts .history
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acf, corr, drawdowns, kurtosis, mean, sd, skew } from './stats.js';

const DIR = process.argv[2] ?? '.history';
const OUT = new URL('../../../../docs/data/history-stats.json', import.meta.url);

type Row = { date: string; v: number[] };

/** The first block of dated rows in a French Data Library CSV (the value-weighted block). */
function french(file: string): { cols: string[]; rows: Row[] } {
  const lines = readFileSync(join(DIR, file), 'utf8').split(/\r?\n/);
  let cols: string[] = [];
  const rows: Row[] = [];
  for (const line of lines) {
    if (line.startsWith(',')) {
      if (rows.length) break;
      cols = line.split(',').slice(1).map((c) => c.trim());
      continue;
    }
    const m = line.match(/^(\d{8}),(.*)$/);
    if (m) rows.push({ date: `${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6)}`, v: m[2]!.split(',').map((x) => Number(x) / 100) });
    else if (rows.length && !line.trim()) break;
  }
  return { cols, rows };
}

function fred(id: string): Row[] {
  return readFileSync(join(DIR, `${id}.csv`), 'utf8').split(/\r?\n/).slice(1).flatMap((l) => {
    const [d, x] = l.split(',');
    return d && x && x !== '.' ? [{ date: d, v: [Number(x)] }] : [];
  });
}

const between = <T extends { date: string }>(rows: T[], from: string, to: string) => rows.filter((r) => r.date >= from && r.date <= to);
const logret = (simple: number) => Math.log(1 + simple);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ---------------------------------------------------------------- broad market

const ff = french('F-F_Research_Data_Factors_daily.csv');
const mkt = ff.rows.map((r) => ({ date: r.date, r: logret(r.v[0]! + r.v[3]!) }));
const modern = between(mkt, '1963-07-01', '9999');
const rm = modern.map((x) => x.r);
const z = sd(rm);

const marketFacts = {
  sample: `${modern[0]!.date} to ${modern.at(-1)!.date}`,
  days: rm.length,
  dailyMean: r4(mean(rm) * 100) / 100,
  dailySd: r4(z),
  annualSd: r4(z * Math.sqrt(252)),
  skew: r4(skew(rm)),
  excessKurtosis: r4(kurtosis(rm) - 3),
  acfReturnLag1: r4(acf(rm, 1)),
  acfAbsLag: Object.fromEntries([1, 5, 20, 60, 120].map((k) => [k, r4(acf(rm.map(Math.abs), k))])),
  leverageEffect: r4(corr(rm.slice(0, -1), rm.slice(1).map((x) => x * x))),
  shareBeyond3Sd: r4(rm.filter((x) => Math.abs(x - mean(rm)) > 3 * z).length / rm.length),
  shareBeyond5Sd: r4(rm.filter((x) => Math.abs(x - mean(rm)) > 5 * z).length / rm.length),
  worstDay: modern.reduce((a, b) => (b.r < a.r ? b : a)),
  bestDay: modern.reduce((a, b) => (b.r > a.r ? b : a)),
};

const index = (rows: { date: string; r: number }[]) => {
  let lv = 0;
  return rows.map((x) => ({ date: x.date, lv: (lv += x.r) }));
};
const marketDrawdowns = drawdowns(index(mkt), 0.25);

// ---------------------------------------------------------------- industries

const ind = french('12_Industry_Portfolios_Daily.csv');
const indRows = between(ind.rows, '1963-07-01', '9999');
const indCorr = (rows: Row[]) => {
  const k = ind.cols.length;
  const cs: number[] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) cs.push(corr(rows.map((r) => r.v[i]!), rows.map((r) => r.v[j]!)));
  return r4(mean(cs));
};
const mktOn = new Map(mkt.map((x) => [x.date, x.r]));
const industryFacts = {
  names: ind.cols,
  avgPairwiseCorr: indCorr(indRows),
  avgPairwiseCorrCalm2004to2006: indCorr(between(ind.rows, '2004-01-01', '2006-12-31')),
  avgPairwiseCorrCrisis2008Sep2009Mar: indCorr(between(ind.rows, '2008-09-01', '2009-03-31')),
  annualSd: Object.fromEntries(ind.cols.map((c, i) => [c, r4(sd(indRows.map((r) => logret(r.v[i]!))) * Math.sqrt(252))])),
  betaToMarket: Object.fromEntries(ind.cols.map((c, i) => {
    const x = indRows.map((r) => mktOn.get(r.date)!);
    const y = indRows.map((r) => logret(r.v[i]!));
    return [c, r4((corr(x, y) * sd(y)) / sd(x))];
  })),
  /** What is left of each industry's volatility once its market beta is taken out (annual). */
  residualAnnualSd: Object.fromEntries(ind.cols.map((c, i) => {
    const x = indRows.map((r) => mktOn.get(r.date)!);
    const y = indRows.map((r) => logret(r.v[i]!));
    const b = (corr(x, y) * sd(y)) / sd(x);
    return [c, r4(sd(y.map((v, k) => v - b * x[k]!)) * Math.sqrt(252))];
  })),
  /** Each industry's return from the March 2009 trough over the following year: recoveries differ. */
  recoveryYearAfter2009Trough: Object.fromEntries(ind.cols.map((c, i) => [c, r4(Math.exp(between(ind.rows, '2009-03-10', '2010-03-09').reduce((s, r) => s + logret(r.v[i]!), 0)) - 1)])),
  gfcDrawdown2007Oct2009Mar: Object.fromEntries(ind.cols.map((c, i) => [c, r4(Math.exp(between(ind.rows, '2007-10-10', '2009-03-09').reduce((s, r) => s + logret(r.v[i]!), 0)) - 1)])),
};

// Industry run-ups and later crashes, in the spirit of Greenwood, Shleifer and You (2019): at each
// month end, an industry up more than 100% over two years; did it then fall 40% from that level at
// some point in the next two years? Compared with the same question asked of every industry-month.
const monthly = (rows: Row[], col: number) => {
  const out: { month: string; lv: number }[] = [];
  let lv = 0;
  for (const r of rows) {
    lv += logret(r.v[col]!);
    const m = r.date.slice(0, 7);
    if (out.at(-1)?.month === m) out.at(-1)!.lv = lv;
    else out.push({ month: m, lv });
  }
  return out;
};
let runups = 0;
let runupCrashes = 0;
let all = 0;
let allCrashes = 0;
const episodes: { industry: string; month: string; twoYear: number; crashed: boolean }[] = [];
ind.cols.forEach((c, i) => {
  const m = monthly(ind.rows, i);
  let lastEpisode = -99;
  for (let t = 24; t + 24 < m.length; t++) {
    const past = Math.exp(m[t]!.lv - m[t - 24]!.lv) - 1;
    const minAhead = Math.min(...m.slice(t + 1, t + 25).map((x) => x.lv));
    const crashed = Math.exp(minAhead - m[t]!.lv) - 1 <= -0.4;
    all++;
    if (crashed) allCrashes++;
    if (past > 1) {
      runups++;
      if (crashed) runupCrashes++;
      // Episodes: the first month of each run-up, not every month of it.
      if (t - lastEpisode > 1) episodes.push({ industry: c, month: m[t]!.month, twoYear: r4(past), crashed });
      lastEpisode = t;
    }
  }
});
const runupFacts = {
  definition: 'industry two-year return above 100% at a month end; crash = a later 40% fall from that month-end level within 24 months',
  industryMonths: all,
  baseRateCrash: r4(allCrashes / all),
  runupMonths: runups,
  crashGivenRunup: r4(runupCrashes / Math.max(1, runups)),
  episodes,
};

// ---------------------------------------------------------------- size

const me = french('Portfolios_Formed_on_ME_daily.csv');
const lo = me.cols.indexOf('Lo 10');
const hi = me.cols.indexOf('Hi 10');
const meRows = between(me.rows, '1963-07-01', '9999');
const sizeSeries = (col: number, rows: Row[]) => rows.map((r) => logret(r.v[col]!));
const sizeFacts = {
  annualSdSmallestDecile: r4(sd(sizeSeries(lo, meRows)) * Math.sqrt(252)),
  annualSdLargestDecile: r4(sd(sizeSeries(hi, meRows)) * Math.sqrt(252)),
  betaSmallestDecile: r4((corr(meRows.map((r) => mktOn.get(r.date)!), sizeSeries(lo, meRows)) * sd(sizeSeries(lo, meRows))) / sd(meRows.map((r) => mktOn.get(r.date)!))),
  betaLargestDecile: r4((corr(meRows.map((r) => mktOn.get(r.date)!), sizeSeries(hi, meRows)) * sd(sizeSeries(hi, meRows))) / sd(meRows.map((r) => mktOn.get(r.date)!))),
  // Daily figures understate small-company risk: thinly traded shares print stale prices, which damps
  // their daily volatility and market beta. Monthly returns show the risk the daily ones hide.
  ...(() => {
    const m = (col: number) => { const x = monthly(meRows, col); return x.slice(1).map((v, i) => v.lv - x[i]!.lv); };
    const mk = (() => { const x = monthly(meRows.map((r) => ({ date: r.date, v: [Math.expm1(mktOn.get(r.date)!)] })), 0); return x.slice(1).map((v, i) => v.lv - x[i]!.lv); })();
    const beta = (y: number[]) => r4((corr(mk, y) * sd(y)) / sd(mk));
    return {
      monthlyAnnualSdSmallestDecile: r4(sd(m(lo)) * Math.sqrt(12)), monthlyAnnualSdLargestDecile: r4(sd(m(hi)) * Math.sqrt(12)),
      monthlyBetaSmallestDecile: beta(m(lo)), monthlyBetaLargestDecile: beta(m(hi)),
    };
  })(),
  /** The size factor itself (SMB: small minus big), daily, 1963 on. */
  smbAnnualSd: r4(sd(between(ff.rows, '1963-07-01', '9999').map((r) => r.v[1]!)) * Math.sqrt(252)),
  smbAnnualMean: r4(mean(between(ff.rows, '1963-07-01', '9999').map((r) => r.v[1]!)) * 252),
  smbCorrWithMarket: r4(corr(between(ff.rows, '1963-07-01', '9999').map((r) => r.v[1]!), between(ff.rows, '1963-07-01', '9999').map((r) => r.v[0]!))),
  gfcSmallest: r4(Math.exp(between(me.rows, '2007-10-10', '2009-03-09').reduce((s, r) => s + logret(r.v[lo]!), 0)) - 1),
  gfcLargest: r4(Math.exp(between(me.rows, '2007-10-10', '2009-03-09').reduce((s, r) => s + logret(r.v[hi]!), 0)) - 1),
  recoveryYearSmallest: r4(Math.exp(between(me.rows, '2009-03-10', '2010-03-09').reduce((s, r) => s + logret(r.v[lo]!), 0)) - 1),
  recoveryYearLargest: r4(Math.exp(between(me.rows, '2009-03-10', '2010-03-09').reduce((s, r) => s + logret(r.v[hi]!), 0)) - 1),
};

// ---------------------------------------------------------------- momentum

const mom = french('F-F_Momentum_Factor_daily.csv');
const momR = between(mom.rows, '1963-07-01', '9999').map((r) => logret(r.v[0]!));
const momDd = drawdowns(index(mom.rows.map((r) => ({ date: r.date, r: logret(r.v[0]!) }))), 0.3);
// Time-series momentum of the market itself: does the past year predict the next month?
const mm = monthly(mkt.map((x) => ({ date: x.date, v: [Math.expm1(x.r)] })), 0);
const past12: number[] = [];
const next1: number[] = [];
for (let t = 12; t + 1 < mm.length; t++) {
  past12.push(mm[t]!.lv - mm[t - 12]!.lv);
  next1.push(mm[t + 1]!.lv - mm[t]!.lv);
}
const momentumFacts = {
  annualMean: r4(mean(momR) * 252),
  annualSd: r4(sd(momR) * Math.sqrt(252)),
  skew: r4(skew(momR)),
  worstDrawdowns: momDd.slice(0, 3),
  marketPast12mVsNextMonthCorr: r4(corr(past12, next1)),
};

// ---------------------------------------------------------------- FRED: Nasdaq, credit, rates, volatility

const nq = fred('NASDAQCOM').map((x) => ({ date: x.date, p: x.v[0]! }));
const at = (d: string) => nq.find((x) => x.date >= d)!;
const peak = between(nq, '1999-01-01', '2000-12-31').reduce((a, b) => (b.p > a.p ? b : a));
const trough = between(nq, peak.date, '2003-12-31').reduce((a, b) => (b.p < a.p ? b : a));
const recovered = nq.find((x) => x.date > trough.date && x.p >= peak.p);
const nqR = (from: string, to: string) => {
  const s = between(nq, from, to);
  const r = s.slice(1).map((x, i) => Math.log(x.p / s[i]!.p));
  return r4(sd(r) * Math.sqrt(252));
};
const nasdaqFacts = {
  start1995: at('1995-01-01'),
  peak,
  trough,
  runUp1995ToPeak: r4(peak.p / at('1995-01-01').p - 1),
  peakToTrough: r4(trough.p / peak.p - 1),
  recoveredToPeak: recovered ?? null,
  annualSd1995to1997: nqR('1995-01-01', '1997-12-31'),
  annualSd1999to2002: nqR('1999-01-01', '2002-12-31'),
};

const spread = fred('BAA10Y').map((x) => ({ date: x.date, s: x.v[0]! }));
const vix = fred('VIXCLS').map((x) => ({ date: x.date, s: x.v[0]! }));
const maxOf = (rows: { date: string; s: number }[]) => rows.reduce((a, b) => (b.s > a.s ? b : a));
const creditFacts = {
  baaSpreadMean1990to2006: r4(mean(between(spread, '1990-01-01', '2006-12-31').map((x) => x.s))),
  baaSpreadPeak2008to2009: maxOf(between(spread, '2008-01-01', '2009-12-31')),
  baaSpreadMin2004to2007: between(spread, '2004-01-01', '2007-06-30').reduce((a, b) => (b.s < a.s ? b : a)),
  vixMedian: r4([...vix.map((x) => x.s)].sort((a, b) => a - b)[Math.floor(vix.length / 2)]!),
  vixPeak2008: maxOf(between(vix, '2008-01-01', '2009-12-31')),
  vixPeak2020: maxOf(between(vix, '2020-01-01', '2020-12-31')),
};
// Credit and equities day by day: the market's return against the change in the Baa spread, and how
// slowly the spread itself mean-reverts (daily AR(1) on the level, as a half-life in trading days).
const spreadOn = new Map(spread.map((x) => [x.date, x.s]));
const paired = modern.filter((x) => spreadOn.has(x.date));
const dS: number[] = [];
const rS: number[] = [];
for (let k = 1; k < paired.length; k++) {
  dS.push(spreadOn.get(paired[k]!.date)! - spreadOn.get(paired[k - 1]!.date)!);
  rS.push(paired[k]!.r);
}
const lv = spread.map((x) => x.s);
const ar1 = corr(lv.slice(0, -1), lv.slice(1));
Object.assign(creditFacts, {
  marketReturnPerSpreadPoint: r4((corr(dS, rS) * sd(rS)) / sd(dS)),
  corrMarketWithSpreadChange: r4(corr(dS, rS)),
  dailySdSpreadChange: r4(sd(dS)),
  spreadAr1Daily: r4(ar1),
  spreadHalfLifeDays: Math.round(Math.log(0.5) / Math.log(ar1)),
});

const tenYear = fred('DGS10').map((x) => ({ date: x.date, s: x.v[0]! }));
const rateFacts = {
  tenYear2021Low: between(tenYear, '2021-01-01', '2021-12-31').reduce((a, b) => (b.s < a.s ? b : a)),
  tenYear2023High: maxOf(between(tenYear, '2023-01-01', '2023-12-31')),
  nasdaq2022: { start: at('2022-01-03'), low: between(nq, '2022-01-01', '2022-12-31').reduce((a, b) => (b.p < a.p ? b : a)) },
};

// ---------------------------------------------------------------- business cycle and industry momentum

// NBER recession months (FRED USREC, monthly 0/1): market behaviour inside and outside them.
const rec = new Set(fred('USREC').filter((x) => x.v[0] === 1).map((x) => x.date.slice(0, 7)));
const inRec = modern.filter((x) => rec.has(x.date.slice(0, 7))).map((x) => x.r);
const outRec = modern.filter((x) => !rec.has(x.date.slice(0, 7))).map((x) => x.r);
const spells = (flag: boolean) => {
  const months = fred('USREC').filter((x) => x.date >= '1945-01-01');
  const out: number[] = [];
  let run = 0;
  for (const m of months) {
    if ((m.v[0] === 1) === flag) run++;
    else if (run) {
      out.push(run);
      run = 0;
    }
  }
  return out;
};
const cycleFacts = {
  recessionShareOfDays: r4(inRec.length / modern.length),
  annualMeanInRecession: r4(mean(inRec) * 252),
  annualMeanOutsideRecession: r4(mean(outRec) * 252),
  annualSdInRecession: r4(sd(inRec) * Math.sqrt(252)),
  annualSdOutsideRecession: r4(sd(outRec) * Math.sqrt(252)),
  meanRecessionMonthsSince1945: r4(mean(spells(true))),
  meanExpansionMonthsSince1945: r4(mean(spells(false).slice(1, -1))),
};

// Industry momentum: an industry's past-12-month return relative to the market against its next month.
const indMonthly = ind.cols.map((_, i) => monthly(ind.rows, i));
const mkM = monthly(mkt.map((x) => ({ date: x.date, v: [Math.expm1(x.r)] })), 0);
const pastRel: number[] = [];
const nextRel: number[] = [];
const wml: number[] = [];
for (let t = 12; t + 1 < mkM.length; t++) {
  const ranked = indMonthly.map((m) => ({ past: m[t]!.lv - m[t - 12]!.lv - (mkM[t]!.lv - mkM[t - 12]!.lv), next: m[t + 1]!.lv - m[t]!.lv - (mkM[t + 1]!.lv - mkM[t]!.lv) }));
  for (const x of ranked) {
    pastRel.push(x.past);
    nextRel.push(x.next);
  }
  ranked.sort((a, b) => b.past - a.past);
  wml.push(mean(ranked.slice(0, 3).map((x) => x.next)) - mean(ranked.slice(-3).map((x) => x.next)));
}
const industryMomentum = {
  past12mRelVsNextMonthRelCorr: r4(corr(pastRel, nextRel)),
  top3MinusBottom3MonthlyMean: r4(mean(wml)),
  top3MinusBottom3MonthlySd: r4(sd(wml)),
  shareOfMonthsPositive: r4(wml.filter((x) => x > 0).length / wml.length),
};

// ---------------------------------------------------------------- price paths of the cases

/** Total-return level of the market at each month end, relative to a base month's end. */
const marketPath = (base: string, months: string[]) => {
  const end = new Map<string, number>();
  let lvl = 0;
  for (const x of mkt) {
    lvl += x.r;
    end.set(x.date.slice(0, 7), lvl);
  }
  return Object.fromEntries(months.map((m) => [m, r4(Math.exp(end.get(m)! - end.get(base)!) - 1)]));
};
const nqYearEnd: Record<string, number> = {};
for (const x of nq) nqYearEnd[x.date.slice(0, 4)] = x.p;
const paths = {
  nasdaqYearEnd: Object.fromEntries(['1994', '1995', '1996', '1997', '1998', '1999', '2000', '2001', '2002', '2003', '2004'].map((y) => [y, nqYearEnd[y]])),
  marketSinceOct2007: marketPath('2007-10', ['2008-01', '2008-03', '2008-06', '2008-09', '2008-10', '2008-11', '2008-12', '2009-01', '2009-02', '2009-03', '2009-06', '2009-09', '2009-12', '2010-03', '2010-06', '2010-12']),
  marketSinceFeb2000: marketPath('2000-02', ['2000-03', '2000-09', '2001-03', '2001-09', '2002-03', '2002-09', '2002-10', '2003-03', '2003-12']),
  marketSinceJan2020: marketPath('2020-01', ['2020-02', '2020-03', '2020-04', '2020-06', '2020-08', '2020-12']),
};

const stats = {
  generated: new Date().toISOString().slice(0, 10),
  sources: {
    french: 'Kenneth R. French Data Library, https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html (CRSP-based)',
    fred: 'FRED, Federal Reserve Bank of St. Louis: NASDAQCOM, BAA10Y, DGS10, VIXCLS',
  },
  market: marketFacts,
  marketDrawdowns,
  industries: industryFacts,
  runups: runupFacts,
  size: sizeFacts,
  momentum: momentumFacts,
  nasdaq: nasdaqFacts,
  credit: creditFacts,
  rates: rateFacts,
  cycle: cycleFacts,
  paths,
  industryMomentum,
};
writeFileSync(OUT, JSON.stringify(stats, null, 2) + '\n');
console.log(JSON.stringify(stats, null, 2));
