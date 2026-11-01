// The market model's behaviour (docs/simulation-test-plan.md): what the redesign promises, checked on
// controlled states and on Monte Carlo runs with fixed seeds.
import { describe, expect, it } from 'vitest';
import { ASSETS, SECTORS } from '../src/market/assets.js';
import { instantiate, quietReports, schedule, TEMPLATES, type Context } from '../src/market/events.js';
import { readoutSurprise, seedReports, summarize } from '../src/market/fundamentals.js';
import { noteId, noteStory } from '../src/market/notes.js';
import { rng } from '../src/market/rng.js';
import { initialState, MarketSim, SIM, sizeLoadings, type MarketState, type SimNote } from '../src/market/sim.js';
import { measure, simulate, simulateEpisodes } from '../scripts/calibration/simulate.js';

const FAIRS = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
const idx = (t: string) => ASSETS.findIndex((a) => a.ticker === t);
const genesis = (seed: number) => initialState(ASSETS, seed, FAIRS);
const sim = (state: MarketState) => new MarketSim(ASSETS, JSON.parse(JSON.stringify(state)), FAIRS);
const run = (s: MarketSim, ticks: number) => {
  const notes: SimNote[] = [];
  for (let t = 0; t < ticks; t++) {
    s.step();
    notes.push(...s.notes);
  }
  return notes;
};
/** A state with one sector's hidden demand, speculation or froth set, and nothing else changed. */
const tilted = (seed: number, sector: string, o: { demand?: number; spec?: number; froth?: number }) => {
  const st = genesis(seed);
  st.sectors = Object.fromEntries(SECTORS.map((s) => [s, { demand: s === sector ? (o.demand ?? 0) : 0, spec: s === sector ? (o.spec ?? 0) : 0, trend: 0 }]));
  if (o.froth) for (const a of ASSETS) if (a.sector === sector) st.assets[a.ticker]!.froth = o.froth;
  return st;
};
const ret = (a: MarketSim, b: MarketSim, i: number) => Math.log(b.prices[i]! / a.prices[i]!);

describe('prices', () => {
  it('compound from log returns and stay valid over decades', () => {
    const r = simulate(3, 25);
    for (const lp of r.logP) for (const x of lp) expect(Number.isFinite(x) && Math.exp(x) * 1 >= SIM.floorCents - 1).toBe(true);
    // The market's daily log returns add up to its level: no lost or invented movement.
    const s = sim(genesis(4));
    const before = Array.from(s.prices);
    let sum = 0;
    const i = idx('SAP');
    let prev = s.prices[i]!;
    for (let t = 0; t < 2000; t++) {
      s.step();
      sum += Math.log(s.prices[i]! / prev);
      prev = s.prices[i]!;
    }
    expect(sum).toBeCloseTo(Math.log(s.prices[i]! / before[i]!), 9);
  });

  it('are reproducible from a seed, news included, and a restart replays the identical tape', () => {
    const a = sim(genesis(11));
    const b = sim(genesis(11));
    expect(run(a, 3000)).toEqual(run(b, 3000));
    expect(Array.from(a.prices)).toEqual(Array.from(b.prices));
    // Stop half way, rebuild from the saved state, carry on: the same prices and the same notes.
    const c = sim(genesis(12));
    run(c, 1500);
    const resumed = sim(c.state());
    expect(run(resumed, 1500)).toEqual(run(c, 1500));
    expect(Array.from(resumed.prices)).toEqual(Array.from(c.prices));
  });
});

describe('upgrading from the previous model', () => {
  it('a checkpoint without the new state loads at the same prices, with value aligned to them', () => {
    const old = genesis(21) as MarketState & { variance?: number };
    for (const x of Object.values(old.assets)) x.logP -= 0.05; // prices that wandered below their anchors
    delete old.variance;
    const s = sim(old);
    const st = s.state();
    for (const a of ASSETS) {
      expect(s.prices[idx(a.ticker)]).toBe(Math.round(Math.exp(old.assets[a.ticker]!.logP)));
      const x = st.assets[a.ticker]!;
      expect(x.fairLog + x.sentiment + x.transient).toBeCloseTo(x.logP, 9);
    }
  });
});

describe('sectors and companies', () => {
  it('a rising sector lifts its companies on average without forcing every one of them up', () => {
    let sectorUp = 0;
    let someoneFell = 0;
    const members = ASSETS.flatMap((a, i) => (a.sector === 'Semiconductors' ? [i] : []));
    for (let seed = 0; seed < 30; seed++) {
      const base = sim(genesis(100 + seed));
      const boom = sim(tilted(100 + seed, 'Semiconductors', { demand: SIM.demandScale * 6 }));
      const start = sim(tilted(100 + seed, 'Semiconductors', {}));
      run(base, 1200);
      run(boom, 1200);
      const moves = members.map((i) => ret(start, boom, i));
      if (moves.reduce((s, x) => s + x, 0) > members.reduce((s, i) => s + ret(start, base, i), 0)) sectorUp++;
      if (moves.some((m) => m < 0)) someoneFell++;
    }
    expect(sectorUp).toBeGreaterThanOrEqual(24);
    expect(someoneFell).toBeGreaterThan(0);
  });

  it('companies in a sector rally differ: a fast grower rides demand harder than a mature giant', () => {
    const fast = idx('NVDA');
    const mature = idx('INTC');
    let gap = 0;
    for (let seed = 0; seed < 20; seed++) {
      const start = sim(tilted(200 + seed, 'Semiconductors', { demand: SIM.demandScale * 6 }));
      const boom = sim(start.state());
      run(boom, 2400);
      gap += ret(start, boom, fast) - ret(start, boom, mature);
    }
    expect(gap / 20).toBeGreaterThan(0);
  });

  it('size is market value, not share price: a cheap share can belong to a large company', () => {
    const size = sizeLoadings(ASSETS);
    // Vodafone trades under a euro and Ferrari-sized prices exist, but loadings follow capitalisation.
    const cheapest = ASSETS.reduce((m, a, i) => (a.base < ASSETS[m]!.base ? i : m), 0);
    expect(ASSETS[cheapest]!.base).toBeLessThan(200);
    expect(Math.abs(size[cheapest]!)).toBeLessThanOrEqual(1.5);
    expect(size[idx('MSFT')]!).toBeLessThan(0);
    expect(size[idx('ORSTED')]!).toBeGreaterThan(0);
  });

  it('a negative shock hits a stock harder the further it trades above what its fundamentals support', () => {
    const i = idx('TSLA');
    const story = { id: 1, seq: 5, duration: 1, jump: 1, persistence: 0.5, severity: 2 as const, effects: [{ asset: i, pct: -0.08 }] };
    const fair = genesis(7);
    fair.assets.TSLA!.sentiment = 0;
    const dear = genesis(7);
    dear.assets.TSLA!.sentiment = 0.5;
    const cheap = sim(fair);
    const dearSim = sim(dear);
    const plain = sim(fair);
    const plainDear = sim(dear);
    cheap.load([story]);
    dearSim.load([{ ...story }]);
    run(cheap, 5);
    run(dearSim, 5);
    run(plain, 5);
    run(plainDear, 5);
    const hitCheap = ret(plain, cheap, i);
    const hitDear = ret(plainDear, dearSim, i);
    expect(hitDear).toBeLessThan(hitCheap);
  });
});

describe('fundamentals and expectations', () => {
  const ctx = (value: (i: number) => number): Context => ({
    assets: ASSETS, reports: (i) => seedReports(ASSETS[i]!), ticksPerSecond: 1, maxTick: 600, at: (t) => t * 1000, value,
  });

  it('earnings follow the business: a beat when its value ran ahead of the reports, a miss when it fell behind', () => {
    const i = idx('SAP');
    expect(readoutSurprise(ASSETS[i]!, seedReports(ASSETS[i]!), FAIRS[i]! * 1.2)).toBeGreaterThan(0);
    expect(readoutSurprise(ASSETS[i]!, seedReports(ASSETS[i]!), FAIRS[i]! * 0.8)).toBeLessThan(0);
  });

  it('a profitable company can still fall on its results, and a loss-maker can rally on smaller losses', () => {
    const profitable = idx('JNJ');
    const missTpl = TEMPLATES.find((t) => t.id === 'earnings-miss')!;
    // Most misses fall (a few were priced in already: the reaction is muted or reversed).
    const misses = Array.from({ length: 40 }, (_, k) => instantiate(missTpl, ctx(() => 0), rng(k), 1, 10, profitable, -0.1));
    expect(misses.every((m) => m.report!.eps > 0)).toBe(true);
    expect(misses.filter((m) => m.effects[0]!.pct < 0).length).toBeGreaterThan(30);
    const loser = ASSETS.findIndex((a) => a.margin < 0);
    const beatTpl = TEMPLATES.find((t) => t.id === 'earnings-beat')!;
    const beats = Array.from({ length: 40 }, (_, k) => instantiate(beatTpl, ctx(() => 0), rng(k), 1, 10, loser, 0.15));
    expect(beats.every((b) => b.report!.eps < 0 && b.report!.eps > b.report!.epsEstimate!)).toBe(true);
    expect(beats.filter((b) => b.effects[0]!.pct > 0).length).toBeGreaterThan(30);
  });

  it('the schedule reads earnings from value, and every other company files quietly without moving its price', () => {
    const rich = ctx((i) => FAIRS[i]! * 1.25);
    const stories = [1, 2, 3, 4, 5, 6].flatMap((s) => schedule(s, rich, 600)).filter((e) => e.template.startsWith('earnings-'));
    expect(stories.length).toBeGreaterThan(0);
    expect(stories.every((e) => e.template === 'earnings-beat')).toBe(true);
    const quiet = quietReports(9, rich, new Set([0, 1]), 600);
    expect(quiet).toHaveLength(ASSETS.length - 2);
    expect(quiet.every((e) => e.effects.length === 0 && e.report && e.tick >= 1 && e.tick < 600)).toBe(true);
  });

  it('a large surprise moves the price more than a small one', () => {
    const t = TEMPLATES.find((x) => x.id === 'earnings-beat')!;
    const small = instantiate(t, ctx(() => 0), rng(3), 1, 10, idx('PG'), 0.03);
    const big = instantiate(t, ctx(() => 0), rng(3), 1, 10, idx('PG'), 0.3);
    expect(Math.abs(big.effects[0]!.pct)).toBeGreaterThan(Math.abs(small.effects[0]!.pct));
  });
});

describe('bubbles, crashes and recoveries', () => {
  it('froth raises a sector crash hazard without making a crash certain', () => {
    let calm = 0;
    let hot = 0;
    const N = 40;
    for (let seed = 0; seed < N; seed++) {
      calm += run(sim(tilted(300 + seed, 'Technology', {})), 2400).filter((n) => n.kind === 'sector-crash' && n.sector === 'Technology').length > 0 ? 1 : 0;
      hot += run(sim(tilted(300 + seed, 'Technology', { froth: 0.35 })), 2400).filter((n) => n.kind === 'sector-crash' && n.sector === 'Technology').length > 0 ? 1 : 0;
    }
    expect(hot).toBeGreaterThan(calm);
    expect(hot).toBeLessThan(N);
  });

  it('an overheated sector can keep rising: speculation feeds a rally before anything breaks', () => {
    let rose = 0;
    const members = ASSETS.flatMap((a, i) => (a.sector === 'E-commerce' ? [i] : []));
    for (let seed = 0; seed < 20; seed++) {
      const start = sim(tilted(400 + seed, 'E-commerce', { spec: SIM.specMax, froth: 0.2 }));
      const later = sim(start.state());
      const notes = run(later, 600);
      if (!notes.some((n) => n.kind === 'sector-crash' && n.sector === 'E-commerce') && members.reduce((s, i) => s + ret(start, later, i), 0) > 0) rose++;
    }
    expect(rose).toBeGreaterThan(0);
  });

  it('a sector crash falls on that sector, and a panic on everyone, unevenly, with uneven recoveries', () => {
    // Search seeds for one of each, then check who moved.
    let checkedCrash = false;
    let checkedPanic = false;
    for (let seed = 0; seed < 400 && !(checkedCrash && checkedPanic); seed++) {
      const s = sim(tilted(500 + seed, 'Technology', { froth: 0.5 }));
      for (let t = 0; t < 2400; t++) {
        const before = Array.from(s.prices);
        s.step();
        const crash = s.notes.find((n) => n.kind === 'sector-crash');
        const panic = s.notes.find((n) => n.kind === 'panic');
        const move = (i: number) => Math.log(s.prices[i]! / before[i]!);
        if (crash && !panic && !checkedCrash) {
          const inside = ASSETS.flatMap((a, i) => (a.sector === crash.sector ? [move(i)] : []));
          const outside = ASSETS.flatMap((a, i) => (a.sector !== crash.sector ? [Math.abs(move(i))] : []));
          expect(Math.max(...inside)).toBeLessThan(-0.03);
          expect(Math.max(...outside)).toBeLessThan(0.05);
          checkedCrash = true;
        }
        if (panic && !checkedPanic) {
          const moves = ASSETS.map((_, i) => move(i));
          expect(moves.filter((m) => m < 0).length).toBeGreaterThan(ASSETS.length * 0.9);
          expect(Math.max(...moves) - Math.min(...moves)).toBeGreaterThan(0.02);
          // A month on, companies have recovered by different amounts.
          const after = Array.from(s.prices);
          for (let k = 0; k < 210; k++) s.step();
          const rebound = ASSETS.map((_, i) => Math.log(s.prices[i]! / after[i]!));
          expect(Math.max(...rebound) - Math.min(...rebound)).toBeGreaterThan(0.05);
          checkedPanic = true;
        }
        if (checkedCrash && checkedPanic) break;
      }
    }
    expect(checkedCrash && checkedPanic).toBe(true);
  });

  it('every crash and panic is published with a cause that matches the state', () => {
    const crash: SimNote = { kind: 'sector-crash', seq: 100, sector: 'Technology', size: -0.2, heat: 0.3, tickers: ['AAPL', 'MSFT'] };
    const s = noteStory(crash, 2.4);
    expect(s.headline).toMatch(/stretched valuations/);
    const cold = noteStory({ ...crash, heat: 0 }, 2.4);
    expect(cold.headline).not.toMatch(/valuation/);
    expect(`${s.headline} ${s.body} ${cold.body}`).not.toMatch(/\b(buy|sell now|will rise|will fall|guaranteed)\b/i);
    expect(noteStory({ kind: 'credit-tight', seq: 5, sector: null, size: 3.1, heat: 0, tickers: [] }, 3.1).headline).toMatch(/3\.1 points/);
    // Ids are negative, stable for the same tick and distinct per sector.
    expect(noteId(crash, 0)).toBeLessThan(0);
    expect(noteId(crash, 0)).toBe(noteId({ ...crash }, 0));
    expect(noteId(crash, 1)).not.toBe(noteId(crash, 0));
  });
});

describe('Monte Carlo shape (60 simulated years, fixed seeds)', () => {
  const m = measure(simulateEpisodes(2000, 6, 10));

  it('has the broad statistical shape of the real market', () => {
    expect(m.market.annualSd).toBeGreaterThan(0.1);
    expect(m.market.annualSd).toBeLessThan(0.22);
    expect(m.market.annualMean).toBeGreaterThan(0.02);
    expect(m.market.annualMean).toBeLessThan(0.18);
    // Fat tails, clustered volatility, falls raising volatility, no free lunch day to day.
    expect(m.market.excessKurtosis).toBeGreaterThan(1);
    expect(m.market.acfAbsLag[1]).toBeGreaterThan(0.08);
    expect(m.market.leverageEffect).toBeLessThan(0);
    expect(Math.abs(m.market.acfReturnLag1)).toBeLessThan(0.08);
    // Sectors move together more in stressed markets than in calm ones.
    expect(m.sectors.avgPairwiseCorrStressed ?? 1).toBeGreaterThan(m.sectors.avgPairwiseCorrCalm ?? 0);
  });

  it('smaller companies are riskier, momentum persists weakly, and crashes are rare but real', () => {
    expect(m.size.monthlyAnnualSdSmallThird).toBeGreaterThan(m.size.monthlyAnnualSdBigThird);
    expect(m.momentum.annualMean).toBeGreaterThan(-0.02);
    expect(m.industryMomentum.past12mRelVsNextMonthRelCorr).toBeLessThan(0.2);
    expect(m.notes['sector-crash']).toBeGreaterThan(0);
    expect(m.notes['sector-crash']).toBeLessThan(1.5);
    expect(m.notes.panic).toBeLessThan(0.5);
  });
});
