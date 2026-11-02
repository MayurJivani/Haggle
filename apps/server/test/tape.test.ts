// The tape is a pure function of seed and tick: what the shared market promises every room.
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/market/assets.js';
import { seedReports, summarize } from '../src/market/fundamentals.js';
import { initialState, type MarketState } from '../src/market/sim.js';
import { EPOCH_TICKS, Tape, type TapeEvent } from '../src/market/tape.js';

const FAIRS = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
const fresh = (seed: number, state?: MarketState, reports = ASSETS.map((a) => seedReports(a))) =>
  new Tape(ASSETS, state ? JSON.parse(JSON.stringify(state)) : initialState(ASSETS, seed, FAIRS), FAIRS, reports, seed);
const play = (t: Tape, ticks: number) => {
  const prices: number[][] = [];
  const planned: TapeEvent[] = [];
  const news: number[] = [];
  for (let k = 0; k < ticks; k++) {
    planned.push(...t.prepare());
    news.push(...t.step().fired.map((e) => e.id));
    prices.push(Array.from(t.sim.prices));
  }
  return { prices, planned, news };
};

describe('the tape', () => {
  it('is identical for the same seed, and different for another', () => {
    const a = play(fresh(5), 1500);
    expect(play(fresh(5), 1500)).toEqual(a);
    expect(play(fresh(6), 1500).prices.at(-1)).not.toEqual(a.prices.at(-1));
  });

  it('plans one schedule per epoch, on every company, with durable ids', () => {
    const { planned } = play(fresh(7), EPOCH_TICKS * 3);
    expect(new Set(planned.map((e) => e.id)).size).toBe(planned.length);
    for (let epoch = 0; epoch < 3; epoch++) {
      const here = planned.filter((e) => e.seq > epoch * EPOCH_TICKS && e.seq <= (epoch + 1) * EPOCH_TICKS);
      expect(new Set(here.flatMap((e) => (e.report ? [e.report.ticker] : []))).size).toBe(ASSETS.length);
      expect(here.filter((e) => e.scope === 'market').length).toBeGreaterThan(0);
    }
  });

  it('a restart from any checkpoint replays the same tape, stored stories or not', () => {
    for (const at of [1, 10, 599, 600, 601, 1234]) {
      const reports = ASSETS.map((a) => seedReports(a));
      const a = fresh(9, undefined, reports);
      const first = play(a, at);
      const state = a.sim.state();
      const kept = reports.map((r) => [...r]);
      const rest = play(a, 1000);
      const b = fresh(9, state, kept);
      b.load(first.planned.filter((e) => e.seq > at));
      expect(play(b, 1000).prices).toEqual(rest.prices);
    }
  }, 120_000);

  it('a market upgraded mid-epoch plans the rest of it at once, and only once', () => {
    const t = fresh(13);
    play(t, 250);
    const old = t.sim.state();
    delete old.plannedEpoch;
    const up = fresh(13, old, ASSETS.map((a) => seedReports(a)));
    const planned = up.prepare();
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((e) => e.seq > 250 && e.seq <= EPOCH_TICKS)).toBe(true);
    expect(up.prepare()).toEqual([]);
    const again = fresh(13, up.sim.state(), ASSETS.map((a) => seedReports(a)));
    expect(again.prepare()).toEqual([]);
  });

  it('a paused clock changes nothing: what plays next depends only on the tick', () => {
    // Stopping between competitions is a checkpoint with no ticks: state and stories carry over untouched.
    const a = fresh(11);
    const first = play(a, 700);
    const state = JSON.stringify(a.sim.state());
    expect(JSON.stringify(a.sim.state())).toBe(state);
    expect(first.prices).toHaveLength(700);
    const whole = play(fresh(11), 1400).prices;
    expect([...first.prices, ...play(a, 700).prices]).toEqual(whole);
  });
});

describe('market phases', () => {
  it('come from the economy: all four appear, for stretches, with stress where it should be', () => {
    const seen: Record<string, { ticks: number; variance: number; credit: number; spells: number }> = {};
    for (const seed of [21, 22, 23, 24]) {
      const t = fresh(seed);
      let last = '';
      for (let k = 0; k < 2520 * 20; k++) {
        t.prepare();
        t.step();
        const p = t.sim.phase();
        const s = (seen[p] ??= { ticks: 0, variance: 0, credit: 0, spells: 0 });
        s.ticks++;
        s.variance += t.sim.variance;
        s.credit += t.sim.credit;
        if (p !== last) s.spells++;
        last = p;
      }
    }
    expect(Object.keys(seen).sort()).toEqual(['bear', 'bull', 'crisis', 'sideways']);
    const avg = (p: string, k: 'variance' | 'credit') => seen[p]![k] / seen[p]!.ticks;
    expect(avg('crisis', 'variance')).toBeGreaterThan(avg('bull', 'variance'));
    expect(avg('crisis', 'credit')).toBeGreaterThan(avg('bull', 'credit'));
    // Stretches, not flicker: a phase lasts at least a few simulated days on average.
    for (const s of Object.values(seen)) expect(s.ticks / s.spells).toBeGreaterThan(30);
    }, 120_000);
});

describe('cheap shares', () => {
  it('rounding is display only: the model keeps full precision, so a cent is never a real move', () => {
    const i = ASSETS.findIndex((a) => a.ticker === 'VOD');
    const t = fresh(31);
    let moved = 0;
    let unchanged = 0;
    let prev = t.sim.prices[i]!;
    let prevLog = t.sim.state().assets.VOD!.logP;
    for (let k = 0; k < 3000; k++) {
      t.prepare();
      t.step();
      const now = t.sim.state().assets.VOD!.logP;
      expect(t.sim.prices[i]).toBe(Math.round(Math.exp(now)));
      if (now !== prevLog) moved++;
      if (t.sim.prices[i] === prev) unchanged++;
      prev = t.sim.prices[i]!;
      prevLog = now;
    }
    // The true price moves every tick even while the displayed cents stand still.
    expect(moved).toBe(3000);
    expect(unchanged).toBeGreaterThan(300);
  });
});
