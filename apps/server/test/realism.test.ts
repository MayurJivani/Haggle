// Prices a player would call absurd, checked on the whole 150-company market over the life of a server:
// 160 simulated years is about 640 rounds. See docs/simulation-test-plan.md.
import { describe, expect, it } from 'vitest';
import { ASSETS, CORE_TICKERS, SECTORS } from '../src/market/assets.js';
import { schedule, TEMPLATES, instantiate, type Context } from '../src/market/events.js';
import { peRatio, seedReports, summarize, trendGrowth } from '../src/market/fundamentals.js';
import { rng } from '../src/market/rng.js';
import { initialState, MarketSim, SIM } from '../src/market/sim.js';
import { STARTING_CASH } from '../src/trading/portfolio.js';
import { simulate } from '../scripts/calibration/simulate.js';

const FAIRS = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
const ROUND = 60; // simulated days in a ten-minute round

describe('prices stay believable however long the market lives', () => {
  const runs = [simulate(71, 80), simulate(72, 80)];

  it('never reaches the hard limits, and stays in a range a purse can trade', () => {
    let lowest = Infinity;
    let highest = 0;
    let lowRatio = Infinity;
    let highRatio = 0;
    for (const run of runs) run.logP.forEach((lp, i) => {
      const seed = ASSETS[i]!.base;
      for (const l of lp) {
        const cents = Math.exp(l);
        lowest = Math.min(lowest, cents);
        highest = Math.max(highest, cents);
        lowRatio = Math.min(lowRatio, cents / seed);
        highRatio = Math.max(highRatio, cents / seed);
      }
    });
    expect(lowest).toBeGreaterThan(SIM.floorCents * 0.99);
    expect(highest).toBeLessThan(2_000_000); // EUR 20,000
    expect(lowRatio).toBeGreaterThan(0.05);
    expect(highRatio).toBeLessThan(20);
  });

  it('holds a steady level: the typical share never drifts away from its seed price', () => {
    for (const run of runs) for (let day = 10 * 252; day < run.days; day += 10 * 252) {
      const median = Math.exp(quantile(run.logP.map((lp, i) => lp[day]! - Math.log(ASSETS[i]!.base)), 0.5));
      expect(median).toBeGreaterThan(0.5);
      expect(median).toBeLessThan(8);
    }
  });

  it('moves a believable amount in a day and in a round', () => {
    const daily: number[] = [];
    const rounds: number[] = [];
    for (const run of runs) for (const lp of run.logP) {
      for (let d = 1; d < lp.length; d++) daily.push(Math.abs(lp[d]! - lp[d - 1]!));
      for (let d = ROUND; d < lp.length; d += ROUND) rounds.push(Math.abs(lp[d]! - lp[d - ROUND]!));
    }
    // Real stocks: a typical day under 2%, a typical quarter 10 to 20%; doubling or halving in one is rare.
    expect(quantile(daily, 0.5)).toBeLessThan(0.025);
    expect(quantile(daily, 0.999)).toBeLessThan(0.3);
    expect(quantile(rounds, 0.5)).toBeGreaterThan(0.04);
    expect(quantile(rounds, 0.5)).toBeLessThan(0.25);
    expect(quantile(rounds, 0.99)).toBeLessThan(Math.log(2.5));
  });

  it('moves the whole market a believable amount in a round', () => {
    for (const run of runs) {
      const moves: number[] = [];
      for (let d = ROUND; d < run.days; d += ROUND) moves.push(Math.abs(run.market.subarray(d - ROUND, d).reduce((s, r) => s + r, 0)));
      expect(quantile(moves, 0.5)).toBeLessThan(0.15);
      expect(quantile(moves, 1)).toBeLessThan(0.7);
    }
  });
});

describe('a company at an extreme comes back into range', () => {
  const median = (ticker: string, factor: number) => {
    const i = ASSETS.findIndex((a) => a.ticker === ticker);
    const ends = [1, 2, 3, 4, 5].map((seed) => {
      const st = initialState(ASSETS, seed, FAIRS);
      const a = st.assets[ticker]!;
      a.logP += Math.log(factor);
      a.fairLog += Math.log(factor);
      const s = new MarketSim(ASSETS, st, FAIRS);
      for (let t = 0; t < 2520 * 4; t++) s.step();
      return s.prices[i]! / ASSETS[i]!.base;
    });
    return quantile(ends, 0.5);
  };

  it('from far above and far below its range', () => {
    expect(median('SAP', 50)).toBeLessThan(50);
    expect(median('SAP', 0.05)).toBeGreaterThan(0.05);
  });

  it('never lets a report push value outside the range', () => {
    const i = ASSETS.findIndex((a) => a.ticker === 'SAP');
    const s = new MarketSim(ASSETS, initialState(ASSETS, 5, FAIRS), FAIRS);
    s.setFair(i, ASSETS[i]!.base * 1000);
    expect(s.value(i)).toBeLessThanOrEqual(Math.min(ASSETS[i]!.base * 3, SIM.levelCeilCents) * 1.0001);
    s.setFair(i, 1);
    expect(s.value(i)).toBeGreaterThanOrEqual(ASSETS[i]!.base / 3 * 0.9999);
  });
});

describe('growth', () => {
  it('fades: nobody compounds a seed rate forever', () => {
    for (const a of ASSETS) {
      expect(trendGrowth(a, 12)).toBeCloseTo(a.growth, 9);
      expect(Math.abs(trendGrowth(a, 12 + 80) - 0.06)).toBeLessThan(0.01);
    }
  });
});

describe('the listing starts out believable', () => {
  it('every company is priced near its fundamentals and affordable from the default purse', () => {
    for (const [i, a] of ASSETS.entries()) {
      const fund = summarize(a, seedReports(a));
      const ratio = a.base / FAIRS[i]!;
      expect(ratio, `${a.ticker} price over fair value`).toBeGreaterThan(0.25);
      expect(ratio, `${a.ticker} price over fair value`).toBeLessThan(5);
      expect(a.base).toBeLessThan(STARTING_CASH / 2);
      const pe = peRatio(a.base, fund.epsTtm);
      if (typeof pe === 'number') expect(pe, `${a.ticker} P/E`).toBeLessThan(250);
    }
  });
});

describe('news in a room that lists part of the market', () => {
  const ctxFor = (tickers: string[]): Context => {
    const reports = ASSETS.map((a) => seedReports(a));
    return {
      assets: ASSETS, reports: (i) => reports[i]!, ticksPerSecond: 1, maxTick: 600, at: (t) => t * 1000, value: (i) => FAIRS[i]!,
      listed: new Set(ASSETS.flatMap((a, i) => (tickers.includes(a.ticker) ? [i] : []))),
    };
  };
  const banks = ASSETS.filter((a) => a.sector === 'Finance').slice(0, 5).map((a) => a.ticker);

  it('company and sector stories are about what it lists, whenever anything listed can carry them', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const ev of schedule(seed, ctxFor(banks), 600)) {
        if (ev.scope === 'sector' && !TEMPLATES.find((t) => t.id === ev.template)!.sectors) expect(ev.target).toBe('Finance');
      }
      for (const ev of schedule(seed, ctxFor(CORE_TICKERS), 600)) {
        if (ev.scope === 'asset' && ev.target) expect(CORE_TICKERS).toContain(ev.target);
      }
    }
  });

  it('a template nothing listed can carry never crashes the bell', () => {
    const next = rng(9);
    for (const t of TEMPLATES) if (t.scope !== 'basket') expect(() => instantiate(t, ctxFor(banks), next, 1, 10)).not.toThrow();
    for (const s of SECTORS) {
      const one = ASSETS.filter((a) => a.sector === s).slice(0, 5).map((a) => a.ticker);
      for (let seed = 0; seed < 5; seed++) expect(schedule(seed, ctxFor(one), 120).length).toBeGreaterThan(0);
    }
  });

  it('market-wide stories still move every company, so one tape stays consistent across rooms', () => {
    const t = TEMPLATES.find((x) => x.scope === 'market')!;
    expect(instantiate(t, ctxFor(banks), rng(1), 1, 10).effects).toHaveLength(ASSETS.length);
  });
});
