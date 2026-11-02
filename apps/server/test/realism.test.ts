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
import { BOTS, playRound } from '../scripts/lab/gameplay.js';
import { backtest, STRATEGIES } from '../scripts/lab/strategies.js';

const FAIRS = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
const ROUND = 60; // simulated days in a ten-minute round

describe('hard invariants', () => {
  const run = simulate(70, 40);
  it('every price is finite, inside the absolute limits, every tick', () => {
    let bad = 0;
    for (const lp of run.logP) for (const l of lp) if (!Number.isFinite(l) || Math.exp(l) < SIM.floorCents * 0.99 || Math.exp(l) > SIM.ceilCents) bad++;
    expect(bad).toBe(0);
  });
});

// Statistical targets: limits set well outside what docs/data/lab/engine-2.json measured over 200 seeds, so a
// real shift fails and ordinary chance does not. Update them only with a new lab run.
describe('statistical targets, several seeds', () => {
  const runs = [simulate(71, 60), simulate(72, 60), simulate(73, 60)];
  const atEnd = runs.flatMap((run) => run.logP.map((lp) => lp[run.days - 1]!));
  const relEnd = runs.flatMap((run) => run.logP.map((lp, i) => lp[run.days - 1]! - Math.log(ASSETS[i]!.base)));

  it('prices sit in a range a purse can trade', () => {
    expect(Math.exp(quantile(atEnd, 0.01)) / 100).toBeGreaterThan(1);
    expect(Math.exp(quantile(atEnd, 0.5)) / 100).toBeGreaterThan(100);
    expect(Math.exp(quantile(atEnd, 0.5)) / 100).toBeLessThan(500);
    expect(Math.exp(quantile(atEnd, 0.99)) / 100).toBeLessThan(10_000);
  });

  it('nothing runs away: the highest price ever stays below EUR 40,000', () => {
    let highest = 0;
    for (const run of runs) for (const lp of run.logP) for (const l of lp) if (l > highest) highest = l;
    expect(Math.exp(highest) / 100).toBeLessThan(40_000);
  });

  it('the typical share holds a steady level for the life of the server', () => {
    for (const run of runs) for (let day = 20 * 252; day < run.days; day += 10 * 252) {
      const median = Math.exp(quantile(run.logP.map((lp, i) => lp[day]! - Math.log(ASSETS[i]!.base)), 0.5));
      expect(median).toBeGreaterThan(1.3);
      expect(median).toBeLessThan(5);
    }
    expect(Math.exp(quantile(relEnd, 0.01))).toBeGreaterThan(0.1);
    expect(Math.exp(quantile(relEnd, 0.99))).toBeLessThan(12);
  });

  it('moves a believable amount in a day and in a round', () => {
    const daily: number[] = [];
    const rounds: number[] = [];
    for (const run of runs) for (const lp of run.logP) {
      for (let d = 1; d < lp.length; d++) daily.push(Math.abs(lp[d]! - lp[d - 1]!));
      for (let d = ROUND; d < lp.length; d += ROUND) rounds.push(Math.abs(lp[d]! - lp[d - ROUND]!));
    }
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

describe('fairness: no simple rule wins', () => {
  const core = ASSETS.flatMap((a, i) => (a.core ? [i] : []));
  const samples = [81, 82, 83, 84, 85, 86].flatMap((seed) => backtest(simulate(seed, 10), seed, { core }, [1_000_000]));
  const win = (s: string, h: number) => {
    const rows = samples.filter((x) => x.s === s && x.h === h);
    return rows.filter((x) => x.x > 0).length / rows.length;
  };

  it('no mechanical strategy beats the market reliably over a round or five', () => {
    for (const s of Object.keys(STRATEGIES)) {
      if (samples.filter((x) => x.s === s && x.h === 1).length < 100) continue;
      expect(win(s, 1), s).toBeLessThan(0.65);
      expect(win(s, 5), s).toBeLessThan(0.7);
    }
  });

  it('buying below fair value is an opportunity, not a guarantee (it was 72% over five rounds)', () => {
    expect(win('below fair value', 5)).toBeLessThan(0.62);
    expect(win('below fair value', 1)).toBeLessThan(0.58);
  });
});

describe('the game stays a game', () => {
  const core = ASSETS.flatMap((a, i) => (a.core ? [i] : []));
  const rounds = [91, 92, 93, 94, 95].flatMap((seed) => { const run = simulate(seed, 8); return run.rounds.map((_, r) => playRound(run, r, core, seed)).filter((x) => x !== null); });
  const avg = (f: (r: (typeof rounds)[number]) => number) => rounds.reduce((t, r) => t + f(r), 0) / rounds.length;

  it('has lead changes, comebacks, close finishes and news all round', () => {
    expect(avg((r) => r.leadChanges)).toBeGreaterThan(8);
    expect(avg((r) => r.comeback)).toBeGreaterThan(0.35);
    expect(avg((r) => r.closeFinish)).toBeGreaterThan(0.2);
    expect(avg((r) => r.earlyLock)).toBeLessThan(0.45);
    expect(avg((r) => r.stories)).toBeGreaterThan(7);
    expect(avg((r) => r.longestQuiet)).toBeLessThan(14);
    expect(avg((r) => (r.bigCompanies < 3 && r.bigSectors === 0 ? 1 : 0))).toBeLessThan(0.02);
  });

  it('no personality takes more than a third of the wins', () => {
    for (const b of BOTS) expect(rounds.filter((r) => r.winner === b.name).length / rounds.length, b.name).toBeLessThan(0.33);
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
