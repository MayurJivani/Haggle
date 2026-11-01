// Runs the market model for many simulated years and writes its statistics beside the measured
// history, for docs/calibration.md.
//
//   npx tsx scripts/calibration/run-sim.ts [years=400]
//
// Runs independent ten-year episodes from a fresh market (seeds 1000, 1001, ...) and averages their
// statistics: about the horizon a persistent game market lives through (a hundred competitions is
// some 25 simulated years), and short enough that the fixed listing does not drift into
// an index of two or three winners.
import { readFileSync, writeFileSync } from 'node:fs';
import { measure, simulateEpisodes } from './simulate.js';

const YEARS = Number(process.argv[2] ?? 400);
const EPISODE = 10;
const SEEDS = Math.round(YEARS / EPISODE);
const OUT = new URL('../../../../docs/data/sim-stats.json', import.meta.url);
const HISTORY = new URL('../../../../docs/data/history-stats.json', import.meta.url);

const started = Date.now();
const mean = measure(simulateEpisodes(1000, SEEDS, EPISODE));
process.stderr.write(`${YEARS} simulated years in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
const sim = { generated: new Date().toISOString().slice(0, 10), years: YEARS, episodes: SEEDS, episodeYears: EPISODE, mean };
if (!process.env.LAB_SET) writeFileSync(OUT, JSON.stringify(sim, null, 2) + '\n');

const h = JSON.parse(readFileSync(HISTORY, 'utf8'));
const s = sim.mean;
const rows: [string, unknown, unknown][] = [
  ['market annual sd', h.market.annualSd, s.market.annualSd],
  ['market annual mean (log)', +(h.market.dailyMean * 252).toFixed(4), s.market.annualMean],
  ['daily excess kurtosis', h.market.excessKurtosis, s.market.excessKurtosis],
  ['daily skew', h.market.skew, s.market.skew],
  ['acf r lag 1', h.market.acfReturnLag1, s.market.acfReturnLag1],
  ['acf |r| lag 1 / 20 / 120', `${h.market.acfAbsLag[1]} / ${h.market.acfAbsLag[20]} / ${h.market.acfAbsLag[120]}`, `${s.market.acfAbsLag[1]} / ${s.market.acfAbsLag[20]} / ${s.market.acfAbsLag[120]}`],
  ['leverage effect', h.market.leverageEffect, s.market.leverageEffect],
  ['share of days beyond 3 sd', h.market.shareBeyond3Sd, s.market.shareBeyond3Sd],
  ['industry corr all / calm / stressed', `${h.industries.avgPairwiseCorr} / ${h.industries.avgPairwiseCorrCalm2004to2006} / ${h.industries.avgPairwiseCorrCrisis2008Sep2009Mar}`,
    `${s.sectors.avgPairwiseCorr} / ${s.sectors.avgPairwiseCorrCalm} / ${s.sectors.avgPairwiseCorrStressed}`],
  ['recession mean / outside', `${h.cycle.annualMeanInRecession} / ${h.cycle.annualMeanOutsideRecession}`, `${s.cycle.annualMeanInRecession} / ${s.cycle.annualMeanOutsideRecession}`],
  ['recession sd / outside', `${h.cycle.annualSdInRecession} / ${h.cycle.annualSdOutsideRecession}`, `${s.cycle.annualSdInRecession} / ${s.cycle.annualSdOutsideRecession}`],
  ['monthly sd small / big', `${h.size.monthlyAnnualSdSmallestDecile} / ${h.size.monthlyAnnualSdLargestDecile}`, `${s.size.monthlyAnnualSdSmallThird} / ${s.size.monthlyAnnualSdBigThird}`],
  ['monthly beta small / big', `${h.size.monthlyBetaSmallestDecile} / ${h.size.monthlyBetaLargestDecile}`, `${s.size.monthlyBetaSmallThird} / ${s.size.monthlyBetaBigThird}`],
  ['momentum (WML) mean / sd / skew', `${h.momentum.annualMean} / ${h.momentum.annualSd} / ${h.momentum.skew}`, `${s.momentum.annualMean} / ${s.momentum.annualSd} / ${s.momentum.skew}`],
  ['industry momentum corr / top-bottom / share +', `${h.industryMomentum.past12mRelVsNextMonthRelCorr} / ${h.industryMomentum.top3MinusBottom3MonthlyMean} / ${h.industryMomentum.shareOfMonthsPositive}`,
    `${s.industryMomentum.past12mRelVsNextMonthRelCorr} / ${s.industryMomentum.top3MinusBottom3MonthlyMean} / ${s.industryMomentum.shareOfMonthsPositive}`],
  ['40% crash in 2y: base / after doubling', `${h.runups.baseRateCrash} / ${h.runups.crashGivenRunup}`, `${s.runups.baseRateCrash} / ${s.runups.crashGivenRunup}`],
  ['doubling months share', +(h.runups.runupMonths / h.runups.industryMonths).toFixed(4), +(s.runups.runupMonths / s.runups.sectorMonths).toFixed(4)],
];
console.log('| Statistic | History | Simulation |\n| --- | --- | --- |');
for (const [k, a, b] of rows) console.log(`| ${k} | ${a} | ${b} |`);
console.log(`\nBuying after a positive company story, excess return over the market: ${JSON.stringify(s.headlineTrade)}`);
console.log(`\nDrawdowns per 100 years: over 25% ${s.drawdowns.per100YearsOver25}, over 40% ${s.drawdowns.per100YearsOver40}; notes per year ${JSON.stringify(s.notes)}; credit ${JSON.stringify(s.credit)}`);
