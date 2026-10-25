import { describe, expect, it } from 'vitest';
import { ASSETS, SECTORS } from '../src/market/assets.js';
import { instantiate, schedule, TEMPLATES, type Context, type ScheduledEvent } from '../src/market/events.js';
import { seedReports, summarize } from '../src/market/fundamentals.js';
import { rng } from '../src/market/rng.js';
import { initialState, MarketSim, SIM, type MarketState, type SimEvent } from '../src/market/sim.js';
import { apply, quote, STARTING_CASH, type Book } from '../src/trading/portfolio.js';

const FAIRS = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
const genesis = (seed: number) => initialState(ASSETS, seed, FAIRS);
const sim = (seed: number, events: SimEvent[] = [], state?: MarketState) => {
  const s = new MarketSim(ASSETS, state ?? genesis(seed), FAIRS);
  s.load(events);
  return s;
};
const tape = (s: MarketSim, ticks: number) => {
  const out: number[][] = [];
  for (let t = 0; t < ticks; t++) {
    s.step();
    out.push(Array.from(s.prices));
  }
  return out;
};
const idx = (ticker: string) => ASSETS.findIndex((a) => a.ticker === ticker);
const CTX: Context = {
  assets: ASSETS,
  reports: (i) => seedReports(ASSETS[i]!),
  ticksPerSecond: 1,
  maxTick: 600,
  at: (t) => 1_800_000_000_000 + t * 1000,
};
let nextId = 1;
const asSim = (ev: ScheduledEvent, seq = ev.tick): SimEvent => ({
  id: nextId++, seq, duration: ev.duration, jump: ev.jump, persistence: ev.persistence, severity: ev.severity, effects: ev.effects,
});
const only = (id: string, seed = 5, tick = 10) => instantiate(TEMPLATES.find((x) => x.id === id)!, CTX, rng(seed), 1, tick);
/** One hand-built event: `pct` on one company. */
const raw = (asset: number, pct: number, over: Partial<SimEvent> = {}): SimEvent => ({
  id: nextId++, seq: 10, duration: 30, jump: 0.5, persistence: 0.8, severity: 2, effects: [{ asset, pct }], ...over,
});
const logDiff = (a: number, b: number) => Math.log(a / b);

describe('stock universe', () => {
  it('lists 100-150 identified companies across every sector', () => {
    expect(ASSETS.length).toBeGreaterThanOrEqual(100);
    expect(ASSETS.length).toBeLessThanOrEqual(150);
    expect(new Set(ASSETS.map((a) => a.sector))).toEqual(new Set(SECTORS));
    expect(new Set(ASSETS.map((a) => a.ticker)).size).toBe(ASSETS.length);
    expect(new Set(ASSETS.map((a) => a.name)).size).toBe(ASSETS.length);
    for (const a of ASSETS) {
      expect(a.ticker).toMatch(/^[A-Z0-9]{1,10}$/);
      expect(a.exchange && a.industry && a.description).toBeTruthy();
      expect(a.base).toBeGreaterThan(0);
      expect(a.vol).toBeGreaterThan(0);
    }
  });
});

describe('market simulation', () => {
  it('is deterministic: same seed, same news and same tape', () => {
    const ev = schedule(42, CTX, 600);
    expect(schedule(42, CTX, 600)).toEqual(ev);
    const a = tape(sim(42, ev.map((e, i) => ({ ...asSim(e), id: 1000 + i }))), 600);
    const b = tape(sim(42, ev.map((e, i) => ({ ...asSim(e), id: 1000 + i }))), 600);
    expect(a).toEqual(b);
    expect(tape(sim(43), 50)).not.toEqual(tape(sim(42), 50));
  });

  it('keeps stable companies calmer than risky ones', () => {
    const t = tape(sim(3), 3000);
    const realised = (i: number) => {
      let s = 0;
      for (let k = 1; k < t.length; k++) s += Math.abs(Math.log(t[k]![i]! / t[k - 1]![i]!));
      return s;
    };
    expect(realised(idx('KO'))).toBeLessThan(realised(idx('TSLA')));
    expect(realised(idx('PG'))).toBeLessThan(realised(idx('NVDA')));
  });

  it('schedules macro, sector and company news, one market-wide shock, and follow-ups on the same company', () => {
    for (const seed of [1, 7, 99]) {
      const ev = schedule(seed, CTX, 600);
      expect(ev.length).toBeGreaterThanOrEqual(7);
      expect(ev.filter((e) => e.scope === 'market')).toHaveLength(1);
      expect(ev.every((e) => e.tick > 0 && e.tick < 600 && e.tick + e.duration <= 600)).toBe(true);
      expect(ev.map((e) => e.ord)).toEqual(ev.map((_, i) => i + 1));
    }
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((s) => schedule(s, CTX, 600));
    expect(new Set(all.map((e) => e.category))).toEqual(new Set(['macro', 'sector', 'company']));
    const follow = all.find((e) => ['probe-cleared', 'probe-fined', 'bid-confirmed', 'talks-collapse'].includes(e.template));
    expect(follow).toBeDefined();
  });

  it('writes stories that report rather than prescribe', () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((s) => schedule(s, CTX, 600));
    for (const e of all) {
      expect(e.headline).not.toMatch(/\{|\}/);
      expect(e.body).not.toMatch(/\{|\}/);
      expect(`${e.headline} ${e.body}`).not.toMatch(/\b(buy|sell|will rise|will fall|guaranteed)\b/i);
    }
  });

  it('an earnings story files the next quarter, with EPS against its estimate', () => {
    const beat = only('earnings-beat');
    const miss = only('earnings-miss', 6);
    expect(beat.report!.eps).toBeGreaterThan(beat.report!.epsEstimate!);
    expect(miss.report!.eps).toBeLessThan(miss.report!.epsEstimate!);
    expect(beat.report!.fiscalYear * 4 + beat.report!.fiscalQuarter).toBe(2026 * 4 + 3);
    expect(beat.figures.map((f) => f.label)).toEqual(['EPS', 'Revenue', 'Net income']);
  });

  it('an asset event moves only its company, in the stated direction', () => {
    const ev = only('earnings-beat');
    const i = ev.effects[0]!.asset;
    const a = tape(sim(9), 120).at(-1)!;
    const b = tape(sim(9, [asSim(ev)]), 120).at(-1)!;
    expect(ASSETS.filter((_, k) => a[k] !== b[k]).map((x) => x.ticker)).toEqual([ev.target]);
    expect(Math.sign(b[i]! - a[i]!)).toBe(Math.sign(ev.effects[0]!.pct));
  });

  it('cross-sector effects follow sensitivities: dear oil lifts producers and grounds airlines', () => {
    const ev = only('oil-spike');
    const a = tape(sim(9), 200).at(-1)!;
    const b = tape(sim(9, [asSim(ev)]), 200).at(-1)!;
    const delta = (t: string) => b[idx(t)]! - a[idx(t)]!;
    expect(delta('XOM')).toBeGreaterThan(0);
    expect(delta('RYA')).toBeLessThan(0);
    expect(delta('LHA')).toBeLessThan(0);
    expect(delta('MSFT')).toBe(0);
  });

  it('a rate hike pressures expensive growth stocks and helps banks', () => {
    const ev = only('rate-hike');
    const a = tape(sim(9), 200).at(-1)!;
    const b = tape(sim(9, [asSim(ev)]), 200).at(-1)!;
    expect(b[idx('SHOP')]!).toBeLessThan(a[idx('SHOP')]!);
    expect(b[idx('JPM')]!).toBeGreaterThan(a[idx('JPM')]!);
  });

  it('a market-wide panic moves everything down', () => {
    const ev = only('market-panic');
    const a = tape(sim(9), 40).at(-1)!;
    const b = tape(sim(9, [asSim(ev)]), 40).at(-1)!;
    expect(ASSETS.every((_, i) => b[i]! < a[i]!)).toBe(true);
  });
});

// Every case the runaway-price exploit could hide in, from the audit list.
describe('runaway-price exploit', () => {
  // The exploit as players found it: the crier calls good news, everyone buys, the price keeps
  // climbing. It came from the old model drifting most of each move in after the headline.
  it('buying on a headline buys only the noise that follows: the move is all on the published tick', () => {
    const ids = ['earnings-beat', 'takeover-rumour', 'sector-frenzy', 'datacenter-capex', 'oil-spike', 'market-panic', 'trial-failure'];
    for (const id of ids) for (const seed of [3, 5, 8]) {
      const ev = { ...asSim(only(id, seed, 20)), seq: 20 };
      const quiet = tape(sim(seed), 640);
      const news = tape(sim(seed, [ev]), 640);
      for (const { asset, pct } of ev.effects) {
        const gap = (t: number) => logDiff(news[t - 1]![asset]!, quiet[t - 1]![asset]!);
        const move = gap(20);
        if (Math.abs(pct) > 0.01) expect(Math.sign(move)).toBe(Math.sign(pct));
        expect(gap(19)).toBe(0);
        // A market-wide shock also raises volatility for a while, which spreads the two paths apart
        // in no particular direction; there is no drift to compare, so only its jump is checked.
        if (ev.severity === 3) continue;
        // Over the rest of a ten-minute competition, at most a sliver of the move is predictable:
        // the slow fade of its temporary share, far inside ordinary noise.
        for (const later of [30, 80, 200, 620]) {
          // Plus one cent of rounding, which is a real percentage on a stock priced in cents.
          const cent = 1 / Math.min(news[later - 1]![asset]!, quiet[later - 1]![asset]!);
          expect(Math.abs(gap(later) - move)).toBeLessThanOrEqual(0.15 * Math.abs(move) + 0.002 + cent);
        }
      }
    }
  });

  it('applies the same event once, however often it is loaded', () => {
    const ev = raw(idx('NVDA'), 0.12);
    const once = tape(sim(11, [ev]), 200);
    const s = sim(11, [ev, ev]);
    s.load([ev]);
    expect(tape(s, 200)).toEqual(once);
  });

  it('retrying an event that already landed does not move the price again', () => {
    const ev = raw(idx('NVDA'), 0.12);
    const a = sim(11, [ev]);
    const b = sim(11, [ev]);
    tape(a, 50);
    tape(b, 50);
    b.load([{ ...ev }]);
    b.load([{ ...ev, seq: b.seq + 1 }]);
    expect(tape(b, 200)).toEqual(tape(a, 200));
  });

  it('orders never reach the price model: buying hard leaves the tape untouched', () => {
    const quiet = tape(sim(12), 300);
    const s = sim(12);
    const book: Book = { cash: STARTING_CASH * 1000, positions: new Map() };
    const busy: number[][] = [];
    const k = idx('KO');
    for (let t = 0; t < 300; t++) {
      for (let n = 0; n < 50; n++) {
        const fill = quote(book, 'buy', 'KO', 10, s.prices[k]!);
        if (fill.ok) apply(book, fill);
      }
      s.step();
      busy.push(Array.from(s.prices));
    }
    expect(book.positions.get('KO')!.qty).toBeGreaterThan(0);
    expect(busy).toEqual(quiet);
  });

  it('a long-running positive story adds its stated move and no more', () => {
    const i = idx('SAP');
    const ev = raw(i, 0.1, { duration: 50_000, jump: 0, persistence: 1 });
    const a = sim(13);
    const b = sim(13, [ev]);
    let worst = 0;
    for (let t = 0; t < 60_000; t++) {
      a.step();
      b.step();
      worst = Math.max(worst, logDiff(b.prices[i]!, a.prices[i]!));
    }
    expect(worst).toBeLessThanOrEqual(Math.log(1.1) + 0.01);
  });

  it('the temporary part of a move fades over competitions and the lasting part decays toward fundamentals', () => {
    const i = idx('SAP');
    const gapAt = (ev: SimEvent, ticks: number[]) => {
      const a = tape(sim(14), Math.max(...ticks) + 1);
      const b = tape(sim(14, [ev]), Math.max(...ticks) + 1);
      return ticks.map((t) => logDiff(b[t]![i]!, a[t]![i]!));
    };
    const [t0 = 0, t1 = 0] = gapAt(raw(i, 0.12, { persistence: 0 }), [20, SIM.transientHalfLife * 3]);
    expect(t0).toBeGreaterThan(Math.log(1.11));
    expect(t1).toBeLessThan(t0 / 4);
    const [l0 = 0, l1 = 0] = gapAt(raw(i, 0.12, { persistence: 1 }), [20, SIM.sentimentHalfLife * 3]);
    expect(l0).toBeGreaterThan(Math.log(1.11));
    expect(l1).toBeLessThan(l0 / 4);
  });

  it('many simultaneous stories on one company stay inside the per-tick and rolling-window bounds', () => {
    const i = idx('TSLA');
    const pile = Array.from({ length: 40 }, () => raw(i, 0.6, { duration: 5, jump: 1, persistence: 1 }));
    const a = tape(sim(15), 200);
    const b = tape(sim(15, pile), 200);
    let prev = b[0]![i]!;
    for (const row of b.slice(1)) {
      expect(Math.abs(logDiff(row[i]!, prev))).toBeLessThanOrEqual(SIM.maxShockTick + SIM.maxTick + 1e-3);
      prev = row[i]!;
    }
    // Over one window the stories can add at most the window bound, plus what reversion and noise do anyway.
    expect(logDiff(b[SIM.window]![i]!, a[SIM.window]![i]!)).toBeLessThan(SIM.maxWindowEvent + 0.08);
  });

  it('a restart resumes from its checkpoint without replaying a shock that already landed', () => {
    const i = idx('ASML');
    const ev = raw(i, 0.15, { seq: 40, duration: 60 });
    const late = raw(idx('BMW'), -0.1, { seq: 150 });
    const straight = tape(sim(16, [ev, late]), 300);

    const first = sim(16, [ev, late]);
    tape(first, 70);
    // What a checkpoint stores: JSON in Postgres.
    const restored = sim(16, [ev, late], JSON.parse(JSON.stringify(first.state())));
    const resumed = tape(restored, 230);
    expect(resumed).toEqual(straight.slice(70));
  });

  it('extreme stories never produce an invalid price', () => {
    for (const seed of [1, 2, 3]) {
      const storm: SimEvent[] = [];
      for (let t = 1; t < 400; t += 3) {
        storm.push(raw(t % ASSETS.length, t % 2 ? 0.6 : -0.95, { seq: t, duration: 2, jump: 1, persistence: 1, severity: 3 }));
      }
      const s = sim(seed, storm);
      for (let t = 0; t < 1500; t++) {
        s.step();
        for (const p of s.prices) {
          expect(Number.isInteger(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(SIM.floorCents);
          expect(p).toBeLessThanOrEqual(SIM.ceilCents);
        }
      }
      expect(s.stress).toBeLessThanOrEqual(SIM.stressMax);
    }
  });

  it('carries prices across competitions: the next one opens where the last one closed', () => {
    const s = sim(17);
    tape(s, 600);
    const closing = Array.from(s.prices);
    const next = sim(17, [], JSON.parse(JSON.stringify(s.state())));
    expect(Array.from(next.prices)).toEqual(closing);
    expect(next.seq).toBe(600);
  });

  it('a new fair value never jumps the price', () => {
    const i = idx('MSFT');
    const a = sim(18);
    const b = sim(18);
    tape(a, 100);
    tape(b, 100);
    b.setFair(i, FAIRS[i]! * 3);
    a.step();
    b.step();
    expect(Math.abs(logDiff(b.prices[i]!, a.prices[i]!))).toBeLessThan(0.002);
  });
});
