import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/market/assets.js';
import { instantiate, schedule, TEMPLATES, type ScheduledEvent } from '../src/market/events.js';
import { rng } from '../src/market/rng.js';
import { MarketSim, SIM } from '../src/market/sim.js';

const run = (seed: number, events: ScheduledEvent[], ticks: number) => {
  const sim = new MarketSim(seed, ASSETS, events);
  const tape: number[][] = [];
  for (let t = 0; t < ticks; t++) {
    sim.step();
    tape.push(Array.from(sim.prices));
  }
  return tape;
};

describe('market simulation', () => {
  it('has 30-50 real companies across at least seven sectors', () => {
    expect(ASSETS.length).toBeGreaterThanOrEqual(30);
    expect(ASSETS.length).toBeLessThanOrEqual(50);
    expect(new Set(ASSETS.map((a) => a.sector)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(ASSETS.map((a) => a.ticker)).size).toBe(ASSETS.length);
  });

  it('is deterministic: same seed, same tape and same news', () => {
    const ev = schedule(42, ASSETS, 600, 1000);
    expect(schedule(42, ASSETS, 600, 1000)).toEqual(ev);
    expect(run(42, ev, 600)).toEqual(run(42, ev, 600));
    expect(run(43, ev, 50)).not.toEqual(run(42, ev, 50));
  });

  it('keeps every price positive, inside its floor and ceiling, with bounded tick moves', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const ev = schedule(seed, ASSETS, 900, 1000);
      const sim = new MarketSim(seed, ASSETS, ev);
      let prev = Array.from(sim.prices);
      for (let t = 0; t < 900; t++) {
        sim.step();
        sim.prices.forEach((p, i) => {
          expect(Number.isInteger(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(SIM.floorCents);
          expect(p).toBeLessThanOrEqual(Math.round(ASSETS[i]!.base * SIM.ceiling));
          expect(Math.abs(Math.log(p / prev[i]!))).toBeLessThanOrEqual(SIM.maxShockTick + 0.01);
        });
        prev = Array.from(sim.prices);
      }
    }
  });

  it('schedules a market-wide shock and a steady flow of events', () => {
    const ev = schedule(7, ASSETS, 600, 1000);
    expect(ev.length).toBeGreaterThanOrEqual(6);
    expect(ev.filter((e) => e.scope === 'market')).toHaveLength(1);
    expect(ev.every((e) => e.tick > 0 && e.tick < 600 && e.tick + e.duration <= 600)).toBe(true);
  });

  const only = (id: string, seed = 5) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    return instantiate(t, ASSETS, rng(seed), 1, 10, 1, 300);
  };

  /** Runs the same seed with and without one event; anything that differs was moved by the event. */
  const moved = (ev: ScheduledEvent) => {
    const a = run(9, [], 120).at(-1)!;
    const b = run(9, [ev], 120).at(-1)!;
    return ASSETS.filter((_, i) => a[i] !== b[i]);
  };

  it('an asset event moves only its company, in the stated direction', () => {
    const ev = only('earnings-beat');
    const hit = moved(ev);
    expect(hit.map((a) => a.ticker)).toEqual([ev.target]);
    const i = ASSETS.findIndex((a) => a.ticker === ev.target);
    expect(run(9, [ev], 120).at(-1)![i]!).toBeGreaterThan(run(9, [], 120).at(-1)![i]!);
  });

  it('a sector event moves only that sector', () => {
    const ev = only('sector-regulation');
    const hit = moved(ev);
    expect(hit.length).toBe(5);
    expect(hit.every((a) => a.sector === ev.target)).toBe(true);
  });

  it('a factor event follows sensitivities: a chip shortage hurts carmakers and lifts chipmakers', () => {
    const ev = only('chip-shortage');
    const a = run(9, [], 200).at(-1)!;
    const b = run(9, [ev], 200).at(-1)!;
    const delta = (ticker: string) => {
      const i = ASSETS.findIndex((x) => x.ticker === ticker);
      return b[i]! - a[i]!;
    };
    expect(delta('VOW3')).toBeLessThan(0);
    expect(delta('NVDA')).toBeGreaterThan(0);
    expect(delta('KO')).toBe(0);
  });

  it('a market panic moves everything down', () => {
    const ev = only('market-panic');
    const a = run(9, [], 40).at(-1)!;
    const b = run(9, [ev], 40).at(-1)!;
    expect(ASSETS.every((_, i) => b[i]! < a[i]!)).toBe(true);
  });
});
