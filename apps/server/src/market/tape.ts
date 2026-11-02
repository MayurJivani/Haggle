// The one market. Everything a competition can see is a pure function of the market's seed, its engine
// version and the tick: the economy, the prices, the news and the reports. Rooms read the tape; they
// never write to it. Opening, closing or restarting a room cannot change what any tick contains, only
// whether the clock is running (see docs/engine-2-design.md).
import type { Asset } from './assets.js';
import { planEpoch, type Context, type ScheduledEvent } from './events.js';
import { summarize, type Report, type Summary } from './fundamentals.js';
import { MarketSim, type MarketState, type SimEvent } from './sim.js';

/** Recorded on every event and competition. A changed tape needs a new version, so old results stay explainable. */
export const ENGINE_VERSION = '2.0.0';
/** One schedule per this many ticks: the news is planned from the state at the start of the epoch. */
export const EPOCH_TICKS = 600;

/** A planned story, with the durable id and market tick that make replaying it exact. */
export interface TapeEvent extends ScheduledEvent {
  id: number;
  seq: number;
}

/** Planned ids sit far above the serial ids of the old per-room schedules, and repeat exactly on a replay. */
export const eventId = (epoch: number, k: number) => 1e12 + epoch * 10_000 + k;

export const toSim = (ev: { id: number; seq: number; duration: number; jump: number; persistence: number; severity: 1 | 2 | 3; effects: ScheduledEvent['effects'] }): SimEvent => ({
  id: ev.id, seq: ev.seq, duration: ev.duration, jump: ev.jump, persistence: ev.persistence, severity: ev.severity, effects: ev.effects,
});

export class Tape {
  readonly sim: MarketSim;
  readonly summaries: Summary[];
  private readonly events = new Map<number, TapeEvent>();

  constructor(
    readonly assets: Asset[],
    state: MarketState,
    fairs: number[],
    /** Per company, oldest first. */
    readonly reports: Report[][],
    readonly seed: number,
  ) {
    this.sim = new MarketSim(assets, state, fairs);
    this.summaries = assets.map((a, i) => summarize(a, reports[i]!));
  }

  /** Stories loaded back after a restart. Anything already behind the state is ignored by the sim. */
  load(events: TapeEvent[]) {
    for (const ev of events) this.events.set(ev.id, ev);
    this.sim.load(events.map(toSim));
  }

  /** Plans the current epoch if it has not been yet, and returns its new stories. Call before step(). */
  prepare(): TapeEvent[] {
    const seq = this.sim.seq;
    const epoch = Math.floor(seq / EPOCH_TICKS);
    if (epoch <= this.sim.plannedEpoch) return [];
    this.sim.plannedEpoch = epoch;
    // Normally the whole epoch. A market upgraded part way through one plans what is left of it, so its news never goes quiet.
    const ticks = EPOCH_TICKS - (seq % EPOCH_TICKS);
    const ctx: Context = {
      assets: this.assets, reports: (i) => this.reports[i]!, ticksPerSecond: 1, maxTick: ticks, at: (t) => t * 1000, value: (i) => this.sim.value(i),
    };
    // Seed and epoch decide the news, whatever else has run: a separate stream from the prices.
    const planned = planEpoch((Math.imul(this.seed >>> 0, 0x9e3779b1) ^ Math.imul(epoch + 1, 0x85ebca6b)) >>> 0, ctx, ticks)
      .map((e, k) => ({ ...e, id: eventId(epoch, k), seq: seq + e.tick }));
    this.load(planned);
    return planned;
  }

  /** One tick. What landed, and the reports it filed (fair values already updated). */
  step(): { fired: TapeEvent[]; filed: { report: Report; eventId: number; index: number }[] } {
    const fired = this.sim.step().flatMap((s) => this.events.get(s.id) ?? []);
    const filed: { report: Report; eventId: number; index: number }[] = [];
    for (const ev of fired) {
      this.events.delete(ev.id);
      if (!ev.report) continue;
      const i = this.assets.findIndex((a) => a.ticker === ev.report!.ticker);
      const list = this.reports[i];
      if (!list || list.some((r) => r.fiscalYear === ev.report!.fiscalYear && r.fiscalQuarter === ev.report!.fiscalQuarter)) continue;
      list.push(ev.report);
      this.summaries[i] = summarize(this.assets[i]!, list);
      const fair = this.summaries[i]!.fair;
      if (fair) this.sim.setFair(i, fair.cents);
      if (ev.report.epsEstimate) this.sim.surprise(i, (ev.report.eps - ev.report.epsEstimate) / Math.abs(ev.report.epsEstimate));
      filed.push({ report: ev.report, eventId: ev.id, index: i });
    }
    return { fired, filed };
  }
}
