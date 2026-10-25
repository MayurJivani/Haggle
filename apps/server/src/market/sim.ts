import { SECTORS, type Asset } from './assets.js';
import { gauss, rng, type Rng } from './rng.js';

export const SIM = {
  marketVol: 0.0012,
  sectorVol: 0.0016,
  /** Pull toward the anchor per tick: ordinary noise wanders, it does not random-walk off a cliff. */
  reversion: 0.004,
  /**
   * An event moves the anchor with the price, so the headline tick is the whole reaction. The move
   * then unwinds in two parts: the temporary share over transientHalfLife ticks (about five ten-minute
   * competitions), the lasting re-rating over sentimentHalfLife (about twenty), leaving what the
   * fundamentals justify. Both are slow on purpose: a fade fast enough to see within one competition
   * is a trade anyone who read the headline could take.
   */
  transientHalfLife: 3_000,
  sentimentHalfLife: 12_000,
  maxSentiment: 2,
  /** Largest log move allowed on a quiet tick, and on a tick where an event lands. */
  maxTick: 0.05,
  maxShockTick: 0.35,
  /** Largest total log impact one event may have on one company. */
  maxEventLog: 0.3,
  /** Event-driven moves summed over a rolling window of this many ticks cannot exceed maxWindowEvent. */
  window: 60,
  maxWindowEvent: 0.35,
  /** How far a price may stray from its anchor, in log terms (e^1 = 2.7x). */
  maxAnchorGap: 1,
  floorCents: 50,
  ceilCents: 100_000_000,
  /** Market stress raises market-wide noise after big shocks and decays back to calm. */
  stressDecay: 0.997,
  stressMax: 3,
  stressVol: 0.5,
};

/** What the simulation needs to apply one event. `id` is durable (market_events.id). */
export interface SimEvent {
  id: number;
  /** Market sequence number the event lands on. */
  seq: number;
  /** Stored for the record; the price model lands every move on its own tick. */
  duration: number;
  jump: number;
  /** Share of the move the market keeps as lasting sentiment; the rest is temporary and fades. */
  persistence: number;
  severity: 1 | 2 | 3;
  effects: { asset: number; pct: number }[];
}

export interface AssetState {
  logP: number;
  /** Log premium (or discount) over fair value that the market currently holds, and the part of it that is temporary. */
  sentiment: number;
  transient: number;
  fairLog: number;
  /** Decayed sum of recent event-driven moves, for the rolling-window bound. */
  window: number;
}

export interface MarketState {
  seq: number;
  rng: number;
  stress: number;
  assets: Record<string, AssetState>;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const eventLogs = (ev: SimEvent) => ev.effects.map((e) => clamp(Math.log(1 + Math.max(-0.95, e.pct)), -SIM.maxEventLog, SIM.maxEventLog));

/** A brand new market: every price at its seed (or a given start), anchored where it stands. */
export function initialState(assets: Asset[], seed: number, fairCents: number[], start: Record<string, number> = {}): MarketState {
  return {
    seq: 0,
    rng: seed >>> 0,
    stress: 0,
    assets: Object.fromEntries(assets.map((a, i) => {
      const logP = Math.log(start[a.ticker] ?? a.base);
      const fairLog = Math.log(fairCents[i]!);
      return [a.ticker, { logP, sentiment: logP - fairLog, transient: 0, fairLog, window: 0 }];
    })),
  };
}

/**
 * Server-authoritative price model for the one persistent market. Each tick, an asset's log return =
 * beta * market + sector + own noise + a pull toward its anchor (fair value + sentiment + transient)
 * + any event landing on this tick, bounded per tick, per event and per rolling window, then the price
 * is held inside its floor, ceiling and distance from its anchor.
 *
 * News is a jump, never a drift: an event's whole move lands on the tick it is published and the
 * anchor moves with it, so buying (or selling) on a headline buys only the noise that follows. The old
 * model drifted most of the move in after the headline, which made every good headline a free trade.
 *
 * Nothing about orders goes in: trading never moves prices. Every event applies its move exactly once,
 * keyed by id, and the whole state round-trips through state(), so a restart resumes from a checkpoint
 * and replays the identical tape without replaying any shock already inside it.
 */
export class MarketSim {
  seq: number;
  stress: number;
  readonly prices: Int32Array;
  private readonly logP: Float64Array;
  private readonly sentiment: Float64Array;
  private readonly transient: Float64Array;
  private readonly fairLog: Float64Array;
  private readonly window: Float64Array;
  private readonly sectorOf: Int8Array;
  private readonly next: Rng;
  private pending: SimEvent[] = [];
  private readonly known = new Set<number>();

  /** `fairCents` seeds any company the state does not have yet (a new listing). */
  constructor(
    readonly assets: Asset[],
    state: MarketState,
    fairCents: number[],
  ) {
    this.seq = state.seq;
    this.stress = state.stress;
    this.next = rng(state.rng);
    const s = assets.map((a, i) => {
      const known = state.assets[a.ticker];
      if (known) return known;
      const logP = Math.log(a.base);
      const fairLog = Math.log(fairCents[i]!);
      return { logP, sentiment: logP - fairLog, transient: 0, fairLog, window: 0 };
    });
    this.logP = Float64Array.from(s, (x) => x.logP);
    this.sentiment = Float64Array.from(s, (x) => x.sentiment);
    this.transient = Float64Array.from(s, (x) => x.transient ?? 0);
    this.fairLog = Float64Array.from(s, (x) => x.fairLog);
    this.window = Float64Array.from(s, (x) => x.window);
    this.prices = Int32Array.from(this.logP, (l) => Math.round(Math.exp(l)));
    this.sectorOf = Int8Array.from(assets, (a) => SECTORS.indexOf(a.sector));
  }

  /**
   * Adds events. An id seen before is ignored, so loading the same events twice or retrying never
   * doubles a shock. An event whose seq is already behind the market was applied before the
   * checkpoint this state came from: it is inside the state already and is never replayed.
   */
  load(events: SimEvent[]) {
    for (const ev of events) {
      if (this.known.has(ev.id)) continue;
      this.known.add(ev.id);
      if (ev.seq > this.seq) this.pending.push(ev);
    }
    this.pending.sort((a, b) => a.seq - b.seq || a.id - b.id);
  }

  /** Drops every event that has not landed yet (a competition closed early) and returns them. */
  cancelPending(): SimEvent[] {
    const dropped = this.pending;
    this.pending = [];
    return dropped;
  }

  /** Advances one tick and returns the events that landed on it. */
  step(): SimEvent[] {
    const t = ++this.seq;
    const fired: SimEvent[] = [];
    const shock = new Float64Array(this.assets.length);
    const lasting = new Float64Array(this.assets.length);
    while (this.pending.length && this.pending[0]!.seq <= t) {
      const ev = this.pending.shift()!;
      eventLogs(ev).forEach((l, k) => {
        const i = ev.effects[k]!.asset;
        shock[i]! += l;
        lasting[i]! += l * ev.persistence;
      });
      if (ev.severity === 3) this.stress = Math.min(SIM.stressMax, this.stress + 1);
      fired.push(ev);
    }

    // Fixed draw order every tick (market, sectors, assets), independent of events, so one event
    // never shifts which random numbers the rest of the market draws.
    const market = gauss(this.next) * SIM.marketVol * (1 + this.stress * SIM.stressVol);
    const sector = SECTORS.map(() => gauss(this.next) * SIM.sectorVol);

    const keep = 1 - 1 / SIM.window;
    const fadeLasting = 2 ** (-1 / SIM.sentimentHalfLife);
    const fadeTemporary = 2 ** (-1 / SIM.transientHalfLife);
    const lo = Math.log(SIM.floorCents);
    const hi = Math.log(SIM.ceilCents);
    this.assets.forEach((a, i) => {
      const noise = gauss(this.next) * a.vol;
      const recent = this.window[i]! * keep;
      let d = 0;
      if (shock[i]) {
        // Stacked stories are bounded per tick and per rolling window. The anchor moves by exactly
        // what landed, so a clipped story leaves no catch-up drift behind for anyone to trade.
        const room = Math.max(0, Math.min(SIM.maxShockTick, SIM.maxWindowEvent - recent));
        d = clamp(shock[i]!, -room, room);
        const keepShare = lasting[i]! / shock[i]!;
        this.sentiment[i] = clamp(this.sentiment[i]! + d * keepShare, -SIM.maxSentiment, SIM.maxSentiment);
        this.transient[i] = clamp(this.transient[i]! + d * (1 - keepShare), -SIM.maxSentiment, SIM.maxSentiment);
      }
      this.window[i] = recent + Math.abs(d);
      this.sentiment[i]! *= fadeLasting;
      this.transient[i]! *= fadeTemporary;
      const anchor = this.fairLog[i]! + this.sentiment[i]! + this.transient[i]!;
      // The pull is measured from where the shock put the price, so a story adds no pull of its own.
      const pull = SIM.reversion * (anchor - this.logP[i]! - d);
      const r = clamp(a.beta * market + sector[this.sectorOf[i]!]! + noise + pull, -SIM.maxTick, SIM.maxTick) + d;
      const next = clamp(this.logP[i]! + r, anchor - SIM.maxAnchorGap, anchor + SIM.maxAnchorGap);
      this.logP[i] = clamp(next, lo, hi);
      this.prices[i] = Math.round(Math.exp(this.logP[i]!));
    });
    return fired;
  }

  /** Steps forward to `seq`, returning everything that landed on the way. */
  advanceTo(seq: number): SimEvent[] {
    const fired: SimEvent[] = [];
    while (this.seq < seq) fired.push(...this.step());
    return fired;
  }

  /**
   * A new fair value from new fundamentals. The anchor does not jump: the gap moves into sentiment,
   * which fades over sentimentHalfLife, so the price drifts toward what the new numbers justify.
   */
  setFair(i: number, cents: number) {
    const l = Math.log(Math.max(1, cents));
    this.sentiment[i] = this.sentiment[i]! - (l - this.fairLog[i]!);
    this.fairLog[i] = l;
  }

  regime(): 'calm' | 'nervous' | 'stressed' {
    return this.stress < 0.3 ? 'calm' : this.stress < 1 ? 'nervous' : 'stressed';
  }

  state(): MarketState {
    return {
      seq: this.seq,
      rng: this.next.state(),
      stress: this.stress,
      assets: Object.fromEntries(this.assets.map((a, i) => [
        a.ticker,
        { logP: this.logP[i]!, sentiment: this.sentiment[i]!, transient: this.transient[i]!, fairLog: this.fairLog[i]!, window: this.window[i]! },
      ])),
    };
  }
}
