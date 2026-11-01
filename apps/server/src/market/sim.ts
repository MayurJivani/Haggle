import { SECTOR_PROFILE, SECTORS, type Asset, type Sector } from './assets.js';
import { sharesOf } from './fundamentals.js';
import { gauss, rng, type Rng } from './rng.js';

// The model, its parameters and the evidence behind each one are written up in docs/market-model.md
// and docs/calibration.md. Numbers marked "measured" come from docs/data/history-stats.json (Kenneth
// French's CRSP-based data library and FRED, measured by scripts/calibration/measure-history.ts);
// numbers marked "gameplay" are choices about how the game feels, tuned by scripts/calibration/run-sim.ts.

/** Trading days one tick stands for (gameplay): a 600-tick competition is about a quarter, 60 trading days. */
export const DAYS_PER_TICK = 0.1;
export const TICKS_PER_YEAR = 252 / DAYS_PER_TICK;
const perTick = (annualSd: number) => annualSd / Math.sqrt(TICKS_PER_YEAR);
const drift = (annualLog: number) => annualLog / TICKS_PER_YEAR;
const keepFor = (halfLifeTicks: number) => 2 ** (-1 / halfLifeTicks);
const months = (m: number) => (m * 21) / DAYS_PER_TICK;

export const SIM = {
  // ---- market factor
  /**
   * Measured: US market daily log-return sd 1963-2026 is 1.02%, 16.3% a year. The market factor carries
   * only part of that (`marketShare`, tuned): sectors, companies, scheduled news, crashes and the
   * variance they add make up the rest, so the whole cap-weighted index lands on the measured figure.
   */
  marketVol: perTick(0.1626),
  marketShare: 0.8,
  /** Measured: monthly market beta is 1.12 for the smallest size decile and 0.93 for the largest. A company's beta tilts with its size loading. */
  sizeBeta: 0.12,
  /**
   * Measured: market log return averages +12.1% a year outside NBER recessions and -3.8% inside them.
   * Both are used as the drift as measured. The realised recession return in simulation is noisy
   * (recessions are rare: about one in eight years), see docs/calibration.md.
   */
  driftExpansion: drift(0.1212),
  driftRecession: drift(-0.0383),
  /**
   * Measured: annual vol is 14.5% outside recessions and 26.3% inside, and recessions are 11.2% of days.
   * As variance targets around a long-run mean of 1: 0.8 in expansion, 2.62 in recession.
   */
  varExpansion: 0.8,
  varRecession: 2.62,
  /**
   * Volatility clustering: a GJR-GARCH(1,1) on the market shock, in units of the long-run variance.
   * Gameplay-tuned so ten ticks (one simulated day) show the measured clustering: autocorrelation of
   * absolute daily returns 0.26 at one day, 0.20 at twenty and 0.09 at 120; a fall raises volatility
   * more than a rise (measured leverage effect: corr(r, r^2 next day) = -0.09).
   */
  garchAlpha: 0.01,
  garchGamma: 0.04,
  garchBeta: 0.9695,
  /** Gameplay-tuned: how far a severity-3 story (a market-wide shock) lifts volatility, in long-run variances. */
  storyVariance: 0.2,
  // ---- business cycle (hidden)
  /** Measured: NBER expansions since 1945 average 58.4 months, recessions 10.2. */
  expansionTicks: months(58.4),
  recessionTicks: months(10.2),
  /** Gameplay: in a recession a sector's demand is pulled down in proportion to how it fared in 2007-09. */
  recessionDemand: 0.6,
  // ---- credit (hidden level, published when it crosses a band)
  /** Measured: the Baa-Treasury spread averaged 2.06 points 1990-2006, bottomed at 1.48 (2005), peaked at 6.16 (Dec 2008). */
  creditExpansion: 1.9,
  creditRecession: 3.6,
  creditFloor: 1.2,
  creditCeil: 7,
  /** Gameplay: the spread levels at which tightening and easing are reported (the 1990-2006 mean was 2.06). */
  creditTightAt: 3,
  creditEasyAt: 2.2,
  /**
   * Measured: the spread's daily changes have sd 0.036 points, and the level's daily AR(1) half-life
   * is 520 trading days. That half-life mixes regimes; within a regime the spread is pulled to its
   * level faster (tuned: 120 days), so a recession widens spreads while it is still going on.
   */
  creditVol: 0.0359 * Math.sqrt(DAYS_PER_TICK),
  creditHalfLife: 120 / DAYS_PER_TICK,
  /** Measured: the market loses 3.2% per point the spread widens on the same day. */
  creditMarket: -0.0316,
  /** Gameplay: extra loss per point for a fully credit-exposed company (banks, small, leveraged firms). */
  creditExposed: -0.03,
  // ---- sectors
  /** Gameplay: how far demand moves a sector's drift and its earnings expectations (log return per unit per tick). */
  demandDrift: 1,
  /**
   * A sector's demand is a slow AR(1) in per-tick drift units. Gameplay-tuned to the measured industry
   * momentum (12-month winners beat losers by 0.59% a month, in 58% of months): a stationary spread of
   * about 7% a year in sector drift, persisting over roughly a year.
   */
  demandHalfLife: months(14),
  demandScale: drift(0.04),
  demandVol: drift(0.04) * Math.sqrt(1 - keepFor(months(14)) ** 2),
  // ---- speculation (hidden; the premium it builds is visible as price over fair value)
  /**
   * Gameplay-tuned: a sector's lead over the market (decayed over about three months) feeds investors'
   * enthusiasm only beyond specThreshold (20%): a salient run draws the crowd, an ordinary trend does
   * not. Each point of lead beyond it adds about 8.8 points a year of speculative drift, capped at 100%
   * a year. Tuned so that a sector that doubled in two years falls 40% within the next two about 22%
   * of the time against a 3.6% base rate (measured on US industries: 30% against 6.7%), while stock
   * momentum stays at the measured 6.4% a year.
   */
  specFeedback: 0.0035,
  specThreshold: 0.2,
  specHalfLife: months(3),
  trendHalfLife: months(3),
  specDrift: 1,
  specMax: drift(1),
  /** How long the premium that speculation builds takes to fade on its own (gameplay). */
  frothHalfLife: months(30),
  // ---- crashes (hazards; nothing is scheduled)
  /**
   * Gameplay-tuned to the measured run-up evidence: an industry that doubled in two years fell 40%
   * within the next two in 30% of cases, against 6.7% for all industry-months (1926-2026, 12
   * industries; compare Greenwood, Shleifer and You 2019). A sector's crash hazard per tick grows
   * exponentially with its froth and with credit stress.
   */
  sectorHazard: 1 / (80 * TICKS_PER_YEAR),
  heatSlope: 10,
  marketHazard: 1 / months(150),
  marketHeatSlope: 7,
  creditHazard: 0.5,
  /** Gameplay: panics are this much likelier in a recession. */
  recessionPanic: 1.5,
  /** Gameplay: how far a crash widens credit spreads, in points (a bank crash more), and a panic. */
  crashCredit: 0.05,
  crashCreditFinance: 0.3,
  panicCredit: 0.5,
  /** Gameplay: how far a crash and a panic lift volatility, in long-run variances. */
  crashVariance: 0.5,
  panicVariance: 4,
  /** Gameplay: the first-tick fall of a panic, as a range of log moves; the volatility spike carries the rest. */
  panicJump: [0.03, 0.09] as [number, number],
  // ---- company level
  /** Gameplay: share of a company's own noise that is news about its value (the rest reverts). */
  idioInfo: 0.5,
  /** Gameplay: company growth prospects drift slowly; their spread sets stock-level momentum (measured: 6.4% a year). */
  growthHalfLife: months(12),
  growthVol: 0.0000009,
  /** Measured: the size factor (SMB) has annual sd 8.7% and is nearly uncorrelated with the market. */
  sizeVol: perTick(0.0869),
  /** Gameplay: how much harder stress raises a small company's own volatility (thin liquidity). */
  liquidity: 0.3,
  /** Gameplay: a negative shock is amplified by this times the stock's premium over fair value (log), up to twice its size. */
  fragility: 1,
  fragilityCap: 1,
  // ---- the anchor and the bounds (unchanged from the previous model)
  reversion: 0.004,
  transientHalfLife: 3_000,
  sentimentHalfLife: 12_000,
  maxSentiment: 2,
  maxTick: 0.05,
  maxShockTick: 0.35,
  maxEventLog: 0.3,
  window: 60,
  maxWindowEvent: 0.35,
  maxAnchorGap: 1,
  floorCents: 50,
  ceilCents: 100_000_000,
  /**
   * Gameplay: a share stays in a range a fixed purse can trade, however many rounds the market lives. Past
   * levelBand (log, 3x either way from its seed price) a gentle pull with a two-year time constant, at most
   * 30% a year, offsets the long-run drift. Real companies keep share prices tradeable by splitting them;
   * this needs no change to anybody's holdings. levelCeilCents and levelFloorCents bound the range outright.
   */
  levelBand: Math.log(3),
  levelRate: 1 / (2 * TICKS_PER_YEAR),
  levelMax: drift(0.3),
  levelCeilCents: 600_000,
  levelFloorCents: 75,
  /** Long-run variance multiples that the regime label (calm, nervous, stressed) is read from. */
  nervousVar: 1.6,
  stressedVar: 3,
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

/**
 * Something the market itself did, rather than a scheduled story: a sector crash, a market-wide panic,
 * the economy turning, credit tightening or easing. The engine turns each one into news, so every big
 * move has a published cause, and nothing is announced before it happens.
 */
export interface SimNote {
  kind: 'sector-crash' | 'panic' | 'recession' | 'recovery' | 'credit-tight' | 'credit-easy';
  seq: number;
  sector: Sector | null;
  /** The size of the move: the sector or market shock in log terms, or the credit spread in points. */
  size: number;
  /** For a sector crash: the sector's speculative premium over fair value just before it (log). */
  heat: number;
  /** Companies hit hardest, by ticker, for the story's related list. */
  tickers: string[];
}

export interface AssetState {
  logP: number;
  /** Log premium (or discount) over fair value that the market currently holds, and the part of it that is temporary. */
  sentiment: number;
  transient: number;
  fairLog: number;
  /** Decayed sum of recent event-driven moves, for the rolling-window bound. */
  window: number;
  /** Premium built by speculation alone: what a crash unwinds. */
  froth?: number;
  /** The company's own growth prospects (hidden): a slow drift in its value. */
  growth?: number;
}

export interface MarketState {
  seq: number;
  rng: number;
  /** Previous model's stress level; read once to seed the variance of an older checkpoint. */
  stress: number;
  /** Market variance in units of its long-run level (GARCH). */
  variance?: number;
  recession?: boolean;
  /** Ticks since the cycle last turned, and whether that turn has been reported yet. */
  sinceTurn?: number;
  turnReported?: boolean;
  credit?: number;
  creditTight?: boolean;
  /** Per sector: demand (hidden), speculation (hidden), its recent excess return. */
  sectors?: Record<string, { demand: number; spec: number; trend: number }>;
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
 * Relative size within the listing: positive for the smaller companies, negative for the giants, from
 * seed market capitalisation (shares times seed price, never today's price, so a replay is exact).
 * Every company listed is large in absolute terms; this is size relative to the rest of the market.
 */
export function sizeLoadings(assets: Asset[]): number[] {
  const caps = assets.map((a) => Math.log(sharesOf(a) * (a.base / 100)));
  const mid = [...caps].sort((x, y) => x - y)[Math.floor(caps.length / 2)]!;
  const spread = Math.sqrt(caps.reduce((s, c) => s + (c - mid) ** 2, 0) / caps.length);
  return caps.map((c) => clamp((mid - c) / spread, -1.5, 1.5));
}

/**
 * Server-authoritative price model for the one persistent market. Each tick a company's log return is
 *
 *   beta * (market drift + market shock + credit)            the economy, with clustered, fat-tailed volatility
 * + sector exposure * (sector demand + sector shock)         its industry
 * + speculation in its sector                                 enthusiasm, which builds froth over fair value
 * + size loading * (size shock) + credit exposure * credit    small and leveraged companies, and financing
 * + growth + own noise                                        the company itself
 * + a pull toward its anchor (fair value + sentiment + froth + transient)
 * + any scheduled story, sector crash or panic landing on this tick
 *
 * bounded per tick, per event and per rolling window. The parts that are news about value (market,
 * sector, credit, size, demand, growth and half the company's own noise) move its fair value with the
 * price; speculation moves only the froth, so a speculative rally leaves the price stretched over what
 * the fundamentals support, and that stretch is what makes later bad news hit harder and crashes likelier.
 *
 * Hidden states (the business cycle, credit, each sector's demand and speculation, each company's
 * growth) are never sent to players; what they see is the prices, the reports, the published news and
 * the volatility regime. Crashes come from hazards, never from a schedule. Scheduled news is still a
 * jump, never a drift, so a headline is not a free trade.
 *
 * Nothing about orders goes in: trading never moves prices. Every event applies its move exactly once,
 * keyed by id, the draw order per tick is fixed, and the whole state round-trips through state(), so a
 * restart resumes from a checkpoint and replays the identical tape.
 */
export class MarketSim {
  seq: number;
  /** Market variance in units of its long-run level. */
  variance: number;
  recession: boolean;
  credit: number;
  readonly prices: Int32Array;
  private creditTight: boolean;
  private sinceTurn: number;
  private turnReported: boolean;
  private readonly logP: Float64Array;
  private readonly sentiment: Float64Array;
  private readonly transient: Float64Array;
  private readonly froth: Float64Array;
  private readonly growth: Float64Array;
  private readonly fairLog: Float64Array;
  private readonly window: Float64Array;
  private readonly sectorOf: Int8Array;
  private readonly size: Float64Array;
  /** How exposed each company is to credit: its own sensitivity plus being small. */
  private readonly creditExposure: Float64Array;
  /** How strongly each company rides its sector's demand and speculation. */
  private readonly sectorExposure: Float64Array;
  private readonly specExposure: Float64Array;
  private readonly weight: Float64Array;
  private readonly levelLo: Float64Array;
  private readonly levelHi: Float64Array;
  private readonly demand: Float64Array;
  private readonly spec: Float64Array;
  private readonly trend: Float64Array;
  private readonly next: Rng;
  private pending: SimEvent[] = [];
  private readonly known = new Set<number>();
  /** Notes produced by the last step(), for the engine to publish. */
  notes: SimNote[] = [];

  /** `fairCents` seeds any company the state does not have yet (a new listing). */
  constructor(
    readonly assets: Asset[],
    state: MarketState,
    fairCents: number[],
  ) {
    this.seq = state.seq;
    // An older checkpoint carried only a stress level; it maps onto an elevated variance.
    this.variance = state.variance ?? 1 + (state.stress ?? 0);
    this.recession = state.recession ?? false;
    this.sinceTurn = state.sinceTurn ?? 0;
    this.turnReported = state.turnReported ?? true;
    this.credit = state.credit ?? SIM.creditExpansion;
    this.creditTight = state.creditTight ?? this.credit >= SIM.creditTightAt;
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
    this.froth = Float64Array.from(s, (x) => x.froth ?? 0);
    this.growth = Float64Array.from(s, (x) => x.growth ?? 0);
    // A checkpoint from the previous model (no variance recorded) let common market noise wander away
    // from fair value, so prices could sit several percent off their anchors. Loading it, the value of
    // each business starts where its price stands, so the upgrade itself moves no price.
    const legacy = state.variance === undefined;
    this.fairLog = Float64Array.from(s, (x) => (legacy ? x.logP - x.sentiment - (x.transient ?? 0) : x.fairLog));
    this.window = Float64Array.from(s, (x) => x.window);
    this.prices = Int32Array.from(this.logP, (l) => Math.round(Math.exp(l)));
    this.sectorOf = Int8Array.from(assets, (a) => SECTORS.indexOf(a.sector));
    this.size = Float64Array.from(sizeLoadings(assets));
    this.creditExposure = Float64Array.from(assets, (a, i) => Math.max(0, a.sens.credit ?? 0) * 0.5 + Math.max(0, this.size[i]!) * 0.5);
    // A fast grower rides its sector's demand harder than a mature giant; a loss-maker or a
    // high-volatility name rides its speculation harder (gameplay, from each company's simulated profile).
    this.sectorExposure = Float64Array.from(assets, (a) => clamp(0.6 + 2 * a.growth, 0.3, 1.8));
    this.specExposure = Float64Array.from(assets, (a) => clamp(0.4 + a.vol * 150 + (a.margin <= 0 ? 0.5 : 0) + Math.max(0, a.growth) * 2, 0.3, 2.2));
    // Sector weights by seed market capitalisation: how far one company's froth counts in its sector's.
    const caps = assets.map((a) => sharesOf(a) * a.base);
    const totals = SECTORS.map((sec) => assets.reduce((t, a, i) => t + (a.sector === sec ? caps[i]! : 0), 0));
    this.weight = Float64Array.from(assets, (a, i) => caps[i]! / totals[SECTORS.indexOf(a.sector)]!);
    this.levelLo = Float64Array.from(assets, (a) => Math.max(Math.log(a.base) - SIM.levelBand, Math.log(SIM.levelFloorCents)));
    this.levelHi = Float64Array.from(assets, (a) => Math.min(Math.log(a.base) + SIM.levelBand, Math.log(SIM.levelCeilCents)));
    const sec = (k: number) => state.sectors?.[SECTORS[k]!];
    this.demand = Float64Array.from(SECTORS, (_, k) => sec(k)?.demand ?? 0);
    this.spec = Float64Array.from(SECTORS, (_, k) => sec(k)?.spec ?? 0);
    this.trend = Float64Array.from(SECTORS, (_, k) => sec(k)?.trend ?? 0);
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

  /** A company's premium over what its fundamentals support, in log terms: what makes bad news hurt more. */
  premium(i: number) {
    return this.sentiment[i]! + this.froth[i]!;
  }

  /** A sector's speculative froth, weighted by company size: what its crash hazard grows with. */
  heat(k: number) {
    let h = 0;
    this.assets.forEach((_, i) => {
      if (this.sectorOf[i] === k) h += this.weight[i]! * this.froth[i]!;
    });
    return h;
  }

  /** Advances one tick and returns the scheduled events that landed on it; notes go to `notes`. */
  step(): SimEvent[] {
    const t = ++this.seq;
    const n = this.assets.length;
    this.notes = [];
    const fired: SimEvent[] = [];
    const shock = new Float64Array(n);
    const lasting = new Float64Array(n);
    while (this.pending.length && this.pending[0]!.seq <= t) {
      const ev = this.pending.shift()!;
      eventLogs(ev).forEach((l, k) => {
        const i = ev.effects[k]!.asset;
        shock[i]! += l;
        lasting[i]! += l * ev.persistence;
      });
      if (ev.severity === 3) this.variance += SIM.storyVariance;
      fired.push(ev);
    }

    // Fixed draw order every tick, independent of state and events: the market, the size factor,
    // credit, the cycle, then per sector (shock, demand, crash), the market crash, then per company
    // (noise, growth). One event or one crash never shifts which random numbers the rest draws.
    // A bounded normal: fat tails come from volatility clustering and from crash and panic jumps, which
    // is stable; a fat-tailed draw feeding GARCH can blow the variance up into a one-day collapse.
    const zMarket = gauss(this.next);
    const zSize = gauss(this.next);
    const zCredit = gauss(this.next);
    const uCycle = this.next();
    const sectorDraws = SECTORS.map(() => ({ z: gauss(this.next), zd: gauss(this.next), u: this.next(), j: this.next() }));
    const uPanic = this.next();
    const jPanic = this.next();
    const own = this.assets.map(() => ({ z: gauss(this.next), zg: gauss(this.next) }));

    // ---- the economy: cycle, volatility, credit
    this.sinceTurn++;
    if (uCycle < 1 / (this.recession ? SIM.recessionTicks : SIM.expansionTicks)) {
      this.recession = !this.recession;
      this.sinceTurn = 0;
      this.turnReported = false;
    }
    // A turn is recognised in the data about one competition later, not the moment it happens.
    if (!this.turnReported && this.sinceTurn >= 600) {
      this.turnReported = true;
      this.notes.push({ kind: this.recession ? 'recession' : 'recovery', seq: t, sector: null, size: 0, heat: 0, tickers: [] });
    }
    const target = this.recession ? SIM.varRecession : SIM.varExpansion;
    const vol = Math.sqrt(this.variance);
    const marketShock = SIM.marketVol * SIM.marketShare * vol * zMarket;
    const z2 = zMarket * zMarket;
    this.variance = clamp(
      target * (1 - SIM.garchAlpha - SIM.garchBeta - SIM.garchGamma / 2) + (SIM.garchAlpha + (zMarket < 0 ? SIM.garchGamma : 0)) * z2 * this.variance + SIM.garchBeta * this.variance,
      0.2, 25,
    );
    const creditTarget = this.recession ? SIM.creditRecession : SIM.creditExpansion;
    const before = this.credit;
    this.credit = clamp(this.credit + (1 - keepFor(SIM.creditHalfLife)) * (creditTarget - this.credit) + SIM.creditVol * vol * zCredit, SIM.creditFloor, SIM.creditCeil);

    // ---- crashes: a hazard per sector, and one for the whole market, from froth and credit stress
    const stressFromCredit = Math.max(0, this.credit - SIM.creditExpansion) * SIM.creditHazard;
    const crash = new Float64Array(SECTORS.length);
    const heatBefore = new Float64Array(SECTORS.length);
    SECTORS.forEach((sector, k) => {
      const heat = this.heat(k);
      heatBefore[k] = heat;
      const hazard = SIM.sectorHazard * Math.exp(SIM.heatSlope * Math.max(0, heat)) * (1 + stressFromCredit);
      if (sectorDraws[k]!.u < hazard) {
        // The fall unwinds most of the froth and overshoots; bigger bubbles fall further.
        crash[k] = -clamp(0.08 + 0.7 * Math.max(0, heat), 0.08, 0.32) * (0.7 + 0.6 * sectorDraws[k]!.j);
        this.spec[k] = -Math.abs(this.spec[k]!) - SIM.specMax / 2;
        this.variance += SIM.crashVariance;
        this.credit = Math.min(SIM.creditCeil, this.credit + (sector === 'Finance' ? SIM.crashCreditFinance : SIM.crashCredit));
      }
    });
    let marketHeat = 0;
    SECTORS.forEach((_, k) => (marketHeat += this.heat(k) / SECTORS.length));
    const panicHazard = SIM.marketHazard * Math.exp(SIM.marketHeatSlope * Math.max(0, marketHeat)) * (1 + stressFromCredit) * (this.recession ? SIM.recessionPanic : 1);
    const panic = uPanic < panicHazard ? -(SIM.panicJump[0] + (SIM.panicJump[1] - SIM.panicJump[0]) * jPanic) : 0;
    if (panic) {
      this.variance += SIM.panicVariance;
      this.credit = Math.min(SIM.creditCeil, this.credit + SIM.panicCredit * (0.5 + jPanic));
      for (let k = 0; k < SECTORS.length; k++) this.spec[k] = Math.min(this.spec[k]!, 0) - SIM.specMax / 4;
    }
    const dCredit = this.credit - before;
    // Reported with hysteresis, so a spread hovering near a line is not news every few ticks.
    if (!this.creditTight && this.credit >= SIM.creditTightAt) {
      this.creditTight = true;
      this.notes.push({ kind: 'credit-tight', seq: t, sector: null, size: this.credit, heat: 0, tickers: [] });
    } else if (this.creditTight && this.credit <= SIM.creditEasyAt) {
      this.creditTight = false;
      this.notes.push({ kind: 'credit-easy', seq: t, sector: null, size: this.credit, heat: 0, tickers: [] });
    }

    const driftM = this.recession ? SIM.driftRecession : SIM.driftExpansion;
    const sizeShock = SIM.sizeVol * zSize;

    // ---- sectors: demand and speculation evolve; a sector's own shock is shared by its companies
    const keepDemand = keepFor(SIM.demandHalfLife);
    const keepSpec = keepFor(SIM.specHalfLife);
    const sectorShock = SECTORS.map((sector, k) => {
      const p = SECTOR_PROFILE[sector];
      // A recession pulls cyclical demand down and leaves defensive sectors relatively better off.
      const target = this.recession ? -SIM.recessionDemand * (p.crisis - 1) * SIM.demandScale : 0;
      this.demand[k] = keepDemand * this.demand[k]! + (1 - keepDemand) * target + SIM.demandVol * sectorDraws[k]!.zd;
      return perTick(p.residual) * sectorDraws[k]!.z;
    });

    const keep = 1 - 1 / SIM.window;
    const fadeLasting = keepFor(SIM.sentimentHalfLife);
    const fadeTemporary = keepFor(SIM.transientHalfLife);
    const fadeFroth = keepFor(SIM.frothHalfLife);
    const keepGrowth = keepFor(SIM.growthHalfLife);
    const lo = Math.log(SIM.floorCents);
    const hi = Math.log(SIM.ceilCents);
    const sectorReturn = new Float64Array(SECTORS.length);
    const hit: { i: number; d: number }[][] = SECTORS.map(() => []);

    this.assets.forEach((a, i) => {
      const k = this.sectorOf[i]!;
      // Shocks that land on this tick: scheduled stories, a sector crash, a market panic. A negative
      // one hurts more the further the price already stands above what its fundamentals support.
      let story = shock[i]!;
      let fall = (crash[k] ? crash[k]! * this.specExposure[i]! : 0) + panic * a.beta * (1 + SIM.sizeBeta * this.size[i]!) * (1 + this.creditExposure[i]!);
      const raw = story + fall;
      // Stacked shocks are bounded per tick and per rolling window. The anchor moves by exactly what
      // landed, so a clipped shock leaves no catch-up drift behind for anyone to trade.
      const recent = this.window[i]! * keep;
      const room = Math.max(0, Math.min(SIM.maxShockTick, SIM.maxWindowEvent - recent));
      const amplified = raw < 0 ? raw * (1 + SIM.fragility * clamp(this.premium(i), 0, SIM.fragilityCap)) : raw;
      const d = clamp(amplified, -room, room);
      if (raw) {
        story *= d / raw;
        fall *= d / raw;
        // A scheduled story splits into a lasting re-rating and a temporary part, as its template says.
        const share = shock[i] ? lasting[i]! / shock[i]! : 0;
        this.sentiment[i] = clamp(this.sentiment[i]! + story * share, -SIM.maxSentiment, SIM.maxSentiment);
        // A crash or panic takes speculative froth out for good, and the overshoot below it recovers.
        const unwound = fall < 0 ? Math.min(Math.max(0, this.froth[i]!), -fall) : 0;
        this.froth[i] = this.froth[i]! - unwound;
        this.transient[i] = clamp(this.transient[i]! + story * (1 - share) + fall + unwound, -SIM.maxSentiment, SIM.maxSentiment);
        if (fall) hit[k]!.push({ i, d: fall });
      }
      this.window[i] = recent + Math.abs(d);

      // News about value: the economy, credit, the sector, size, the company's prospects, part of its noise.
      this.growth[i] = keepGrowth * this.growth[i]! + SIM.growthVol * own[i]!.zg;
      const liquid = 1 + SIM.liquidity * Math.max(0, this.size[i]!) * Math.max(0, vol - 1);
      const noise = a.vol * own[i]!.z * liquid;
      const beta = a.beta * (1 + SIM.sizeBeta * this.size[i]!);
      const outside = Math.max(0, this.logP[i]! - this.levelHi[i]!) - Math.max(0, this.levelLo[i]! - this.logP[i]!);
      const level = -clamp(SIM.levelRate * outside, -SIM.levelMax, SIM.levelMax);
      const info =
        level + beta * (driftM + marketShock + SIM.creditMarket * dCredit) +
        this.sectorExposure[i]! * (SIM.demandDrift * this.demand[k]! + sectorShock[k]!) +
        this.size[i]! * sizeShock + SIM.creditExposed * this.creditExposure[i]! * dCredit +
        this.growth[i]! + SIM.idioInfo * noise;
      // Speculation: not news about value, so it builds froth over fair value instead.
      const speculative = SIM.specDrift * this.specExposure[i]! * this.spec[k]!;
      this.fairLog[i] = this.fairLog[i]! + info;
      this.froth[i] = clamp(this.froth[i]! * fadeFroth + speculative, -SIM.maxSentiment, SIM.maxSentiment);
      this.sentiment[i]! *= fadeLasting;
      this.transient[i]! *= fadeTemporary;
      const anchor = this.fairLog[i]! + this.sentiment[i]! + this.froth[i]! + this.transient[i]!;
      // The pull is measured from where the shock put the price, so a shock adds no pull of its own.
      const pull = SIM.reversion * (anchor - info - speculative - this.logP[i]! - d);
      const r = clamp(info + speculative + (1 - SIM.idioInfo) * noise + pull, -SIM.maxTick, SIM.maxTick) + d;
      const next = clamp(this.logP[i]! + r, anchor - SIM.maxAnchorGap, anchor + SIM.maxAnchorGap);
      sectorReturn[k]! += this.weight[i]! * (clamp(next, lo, hi) - this.logP[i]!);
      this.logP[i] = clamp(next, lo, hi);
      this.prices[i] = Math.round(Math.exp(this.logP[i]!));
    });

    // Enthusiasm follows a sector's own recent return over the market's (extrapolation), and fades.
    let marketReturn = 0;
    for (let k = 0; k < SECTORS.length; k++) marketReturn += sectorReturn[k]! / SECTORS.length;
    const keepTrend = keepFor(SIM.trendHalfLife);
    for (let k = 0; k < SECTORS.length; k++) {
      this.trend[k] = keepTrend * this.trend[k]! + (sectorReturn[k]! - marketReturn);
      // Only a salient run draws the crowd: the part of the lead beyond specThreshold feeds enthusiasm,
      // so ordinary trends stay weak (momentum) while a big run can turn into a bubble.
      const excess = Math.sign(this.trend[k]!) * Math.max(0, Math.abs(this.trend[k]!) - SIM.specThreshold);
      const wanted = clamp(SIM.specFeedback * excess, -SIM.specMax, SIM.specMax);
      this.spec[k] = clamp(keepSpec * this.spec[k]! + (1 - keepSpec) * wanted, -SIM.specMax, SIM.specMax);
      if (crash[k]) {
        const worst = hit[k]!.sort((x, y) => x.d - y.d).slice(0, 3).map((h) => this.assets[h.i]!.ticker);
        this.notes.push({ kind: 'sector-crash', seq: t, sector: SECTORS[k]!, size: crash[k]!, heat: heatBefore[k]!, tickers: worst });
      }
    }
    if (panic) {
      const worst = hit.flat().sort((x, y) => x.d - y.d).slice(0, 4).map((h) => this.assets[h.i]!.ticker);
      this.notes.push({ kind: 'panic', seq: t, sector: null, size: panic, heat: 0, tickers: worst });
    }
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
    // Inside the long-run range, or reports would undo its pull. Value below the reports reads as a miss, which steadies them too.
    const l = clamp(Math.log(Math.max(1, cents)), this.levelLo[i]!, this.levelHi[i]!);
    this.sentiment[i] = this.sentiment[i]! - (l - this.fairLog[i]!);
    this.fairLog[i] = l;
  }

  /** The market's hidden value of a company per share, in cents: what its reports are read from. */
  value(i: number) {
    return Math.exp(this.fairLog[i]!);
  }

  regime(): 'calm' | 'nervous' | 'stressed' {
    return this.variance < SIM.nervousVar ? 'calm' : this.variance < SIM.stressedVar ? 'nervous' : 'stressed';
  }

  state(): MarketState {
    return {
      seq: this.seq,
      rng: this.next.state(),
      stress: 0,
      variance: this.variance,
      recession: this.recession,
      sinceTurn: this.sinceTurn,
      turnReported: this.turnReported,
      credit: this.credit,
      creditTight: this.creditTight,
      sectors: Object.fromEntries(SECTORS.map((s, k) => [s, { demand: this.demand[k]!, spec: this.spec[k]!, trend: this.trend[k]! }])),
      assets: Object.fromEntries(this.assets.map((a, i) => [
        a.ticker,
        {
          logP: this.logP[i]!, sentiment: this.sentiment[i]!, transient: this.transient[i]!, fairLog: this.fairLog[i]!, window: this.window[i]!,
          froth: this.froth[i]!, growth: this.growth[i]!,
        },
      ])),
    };
  }
}
