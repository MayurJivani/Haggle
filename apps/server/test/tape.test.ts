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
