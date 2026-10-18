import { SECTORS, type Asset } from './assets.js';
import type { ScheduledEvent } from './events.js';
import { gauss, rng } from './rng.js';

export const SIM = {
  marketVol: 0.0012,
  sectorVol: 0.0016,
  /** Pull toward the anchor per tick; a price wanders, it does not random-walk off a cliff. */
  reversion: 0.004,
  /** Largest log move allowed on a quiet tick, and on a tick where an event lands. */
  maxTick: 0.05,
  maxShockTick: 0.3,
  /** Prices stay within [floor, base * ceiling]. */
  floorCents: 50,
  ceiling: 8,
};

interface Active {
  ev: ScheduledEvent;
  /** Log impact per effect, aligned with ev.effects. */
  logs: number[];
}

/**
 * Server-authoritative price model. Prices are a pure function of (seed, assets, schedule, tick):
 * trading never moves them, so a restarted server rebuilds the exact tape by replaying from tick 0.
 *
 * Each tick, an asset's log return = beta * market + sector + own noise + reversion toward its
 * anchor + event drift, clamped, then the price is clamped to its floor and ceiling.
 */
export class MarketSim {
  tick = 0;
  readonly prices: Int32Array;
  private readonly logP: Float64Array;
  private readonly anchor: Float64Array;
  private readonly sectorOf: Int8Array;
  private readonly next: () => number;
  private active: Active[] = [];
  private pending: ScheduledEvent[];

  constructor(
    seed: number,
    readonly assets: Asset[],
    readonly events: ScheduledEvent[],
  ) {
    this.next = rng(seed);
    this.prices = Int32Array.from(assets, (a) => a.base);
    this.logP = Float64Array.from(assets, (a) => Math.log(a.base));
    this.anchor = Float64Array.from(this.logP);
    this.sectorOf = Int8Array.from(assets, (a) => SECTORS.indexOf(a.sector));
    this.pending = [...events].sort((a, b) => a.tick - b.tick);
  }

  /** Advances one tick and returns the events that fired on it. */
  step(): ScheduledEvent[] {
    const t = ++this.tick;
    const fired: ScheduledEvent[] = [];
    while (this.pending.length && this.pending[0]!.tick <= t) {
      const ev = this.pending.shift()!;
      fired.push(ev);
      const logs = ev.effects.map((e) => Math.log(1 + e.pct));
      ev.effects.forEach((e, k) => (this.anchor[e.asset]! += logs[k]! * ev.persistence));
      this.active.push({ ev, logs });
    }

    // Fixed draw order every tick (market, sectors, assets), independent of events.
    const market = gauss(this.next) * SIM.marketVol;
    const sector = SECTORS.map(() => gauss(this.next) * SIM.sectorVol);
    const drift = new Float64Array(this.assets.length);
    const shocked = new Uint8Array(this.assets.length);

    for (const { ev, logs } of this.active) {
      const since = t - ev.tick;
      ev.effects.forEach((e, k) => {
        if (since === 0) {
          drift[e.asset]! += logs[k]! * ev.jump;
          shocked[e.asset] = 1;
        }
        if (since >= 0 && since < ev.duration) drift[e.asset]! += (logs[k]! * (1 - ev.jump)) / ev.duration;
      });
    }
    this.active = this.active.filter(({ ev }) => t - ev.tick < ev.duration - 1);

    this.assets.forEach((a, i) => {
      const noise = gauss(this.next) * a.vol;
      const pull = SIM.reversion * (this.anchor[i]! - this.logP[i]!);
      const limit = shocked[i] ? SIM.maxShockTick : SIM.maxTick;
      const r = Math.max(-limit, Math.min(limit, a.beta * market + sector[this.sectorOf[i]!]! + noise + pull + drift[i]!));
      const lo = Math.log(SIM.floorCents);
      const hi = Math.log(a.base * SIM.ceiling);
      this.logP[i] = Math.max(lo, Math.min(hi, this.logP[i]! + r));
      this.prices[i] = Math.round(Math.exp(this.logP[i]!));
    });
    return fired;
  }

  /** Steps forward to `tick`, returning everything that fired on the way. */
  advanceTo(tick: number): ScheduledEvent[] {
    const fired: ScheduledEvent[] = [];
    while (this.tick < tick) fired.push(...this.step());
    return fired;
  }
}
