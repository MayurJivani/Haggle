import type { Asset, Factor, Sector } from './assets.js';
import { between, rng } from './rng.js';

export type Scope = 'asset' | 'sector' | 'market' | 'factor';

export interface EventTemplate {
  id: string;
  scope: Scope;
  /** For asset and sector scope: only pick targets from these sectors. */
  sectors?: Sector[];
  factor?: Factor;
  /** Total price impact range as a fraction (0.08 = +8%), before per-asset sensitivity. */
  impact: [number, number];
  severity: 1 | 2 | 3;
  /** How long the move takes to play out, in seconds. */
  seconds: [number, number];
  /** Share of the move that lands on the first tick; the rest drifts in over the duration. */
  jump: number;
  /** Share of the move the market keeps afterwards; the rest fades back out. */
  persistence: number;
  headline: string;
  description: string;
  weight: number;
}

// {name}, {ticker} and {sector} are filled from the picked target.
export const TEMPLATES: EventTemplate[] = [
  { id: 'earnings-beat', scope: 'asset', impact: [0.06, 0.13], severity: 2, seconds: [20, 45], jump: 0.6, persistence: 0.9, weight: 5,
    headline: '{name} smashes earnings expectations', description: 'Quarterly profit came in well above analyst forecasts and guidance was raised.' },
  { id: 'earnings-miss', scope: 'asset', impact: [-0.14, -0.06], severity: 2, seconds: [20, 45], jump: 0.6, persistence: 0.9, weight: 5,
    headline: '{name} disappoints with weak results', description: 'Revenue missed forecasts and management cut its outlook for the year.' },
  { id: 'product-launch', scope: 'asset', sectors: ['Technology', 'Semiconductors', 'Automotive', 'Consumer'], impact: [0.04, 0.1], severity: 1, seconds: [30, 70], jump: 0.3, persistence: 0.8, weight: 4,
    headline: '{name} unveils a crowd-pleasing new product', description: 'Early reviews are glowing and pre-orders are running ahead of plan.' },
  { id: 'probe', scope: 'asset', impact: [-0.15, -0.07], severity: 2, seconds: [25, 60], jump: 0.5, persistence: 0.8, weight: 3,
    headline: 'Regulators open an investigation into {name}', description: 'Authorities are examining accounting and competition practices. Fines are possible.' },
  { id: 'ceo-exit', scope: 'asset', impact: [-0.08, -0.04], severity: 1, seconds: [20, 40], jump: 0.7, persistence: 0.7, weight: 2,
    headline: '{name} chief executive resigns unexpectedly', description: 'No successor has been named. The board says strategy is unchanged.' },
  { id: 'buyback', scope: 'asset', impact: [0.03, 0.06], severity: 1, seconds: [30, 60], jump: 0.4, persistence: 0.9, weight: 2,
    headline: '{name} announces a large share buyback', description: 'The company will spend surplus cash repurchasing its own stock.' },
  { id: 'takeover-rumour', scope: 'asset', impact: [0.07, 0.14], severity: 2, seconds: [15, 35], jump: 0.7, persistence: 0.5, weight: 2,
    headline: 'Takeover rumours swirl around {name}', description: 'Reports say a rival is preparing a bid. Neither side has confirmed talks.' },
  { id: 'drug-approval', scope: 'asset', sectors: ['Healthcare'], impact: [0.08, 0.16], severity: 2, seconds: [20, 40], jump: 0.7, persistence: 0.95, weight: 2,
    headline: '{name} wins approval for a major new drug', description: 'Regulators cleared the treatment for a large patient population.' },
  { id: 'trial-failure', scope: 'asset', sectors: ['Healthcare'], impact: [-0.18, -0.09], severity: 2, seconds: [15, 30], jump: 0.8, persistence: 0.95, weight: 2,
    headline: '{name} late-stage trial fails', description: 'A flagship candidate missed its primary endpoint. Years of pipeline value are in doubt.' },
  { id: 'chip-shortage', scope: 'factor', factor: 'chips', impact: [-0.11, -0.06], severity: 2, seconds: [40, 90], jump: 0.3, persistence: 0.8, weight: 3,
    headline: 'Semiconductor shortage hits manufacturers', description: 'Fab outages leave carmakers and hardware makers short of chips. Chipmakers gain pricing power.' },
  { id: 'rate-hike', scope: 'factor', factor: 'rates', impact: [-0.07, -0.04], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.85, weight: 3,
    headline: 'Central bank unexpectedly raises interest rates', description: 'Borrowing gets more expensive. Growth stocks wobble while banks expect fatter margins.' },
  { id: 'rate-cut', scope: 'factor', factor: 'rates', impact: [0.04, 0.07], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.85, weight: 3,
    headline: 'Surprise interest rate cut', description: 'Cheaper money lifts growth stocks. Banks face thinner lending margins.' },
  { id: 'energy-disruption', scope: 'factor', factor: 'oil', impact: [0.08, 0.14], severity: 2, seconds: [30, 70], jump: 0.5, persistence: 0.7, weight: 3,
    headline: 'Energy supply disruption sends oil prices soaring', description: 'A major pipeline outage tightens supply. Producers rally; airlines and logistics feel the fuel bill.' },
  { id: 'consumer-confidence', scope: 'factor', factor: 'consumer', impact: [-0.07, -0.04], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.8, weight: 2,
    headline: 'Consumer confidence slumps to a two-year low', description: 'Households plan to cut spending. Retailers and carmakers are most exposed.' },
  { id: 'sector-boom', scope: 'sector', impact: [0.08, 0.15], severity: 2, seconds: [40, 90], jump: 0.25, persistence: 0.6, weight: 3,
    headline: 'Speculative frenzy sweeps {sector}', description: 'Retail traders pile in and every name in the sector is bid up. Fundamentals have not changed.' },
  { id: 'sector-regulation', scope: 'sector', impact: [-0.1, -0.05], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.85, weight: 2,
    headline: 'Lawmakers announce a crackdown on {sector}', description: 'New rules on pricing and data use are expected to squeeze profits across the sector.' },
  { id: 'market-panic', scope: 'market', impact: [-0.12, -0.07], severity: 3, seconds: [20, 45], jump: 0.6, persistence: 0.5, weight: 0,
    headline: 'Panic selling grips global markets', description: 'A wave of forced selling hits every sector at once. High-beta names fall hardest.' },
  { id: 'market-rally', scope: 'market', impact: [0.06, 0.1], severity: 3, seconds: [30, 60], jump: 0.4, persistence: 0.7, weight: 0,
    headline: 'Stocks surge on blowout jobs data', description: 'A strong economy lifts the whole market. Risk appetite is back.' },
];

export interface Effect {
  /** Index into the asset list. */
  asset: number;
  /** Total move as a fraction, after sensitivity. */
  pct: number;
}

export interface ScheduledEvent {
  seq: number;
  tick: number;
  template: string;
  scope: Scope;
  target: string | null;
  headline: string;
  description: string;
  severity: 1 | 2 | 3;
  duration: number;
  jump: number;
  persistence: number;
  effects: Effect[];
}

const pickWeighted = <T extends { weight: number }>(next: () => number, items: T[]): T => {
  let roll = next() * items.reduce((s, i) => s + i.weight, 0);
  for (const item of items) if ((roll -= item.weight) < 0) return item;
  return items[items.length - 1]!;
};

const clampPct = (p: number) => Math.max(-0.45, Math.min(0.6, p));

export function instantiate(
  t: EventTemplate,
  assets: Asset[],
  next: () => number,
  seq: number,
  tick: number,
  ticksPerSecond: number,
  maxTick: number,
): ScheduledEvent {
  const impact = between(next, t.impact[0], t.impact[1]);
  let target: string | null = null;
  let effects: Effect[] = [];
  let fill: Record<string, string> = {};

  if (t.scope === 'asset') {
    const pool = assets.map((a, i) => ({ a, i })).filter(({ a }) => !t.sectors || t.sectors.includes(a.sector));
    const { a, i } = pool[Math.floor(next() * pool.length)]!;
    target = a.ticker;
    fill = { name: a.name, ticker: a.ticker, sector: a.sector };
    effects = [{ asset: i, pct: impact }];
  } else if (t.scope === 'sector') {
    const sectors = [...new Set(assets.map((a) => a.sector))].filter((s) => !t.sectors || t.sectors.includes(s));
    const sector = sectors[Math.floor(next() * sectors.length)]!;
    target = sector;
    fill = { sector };
    // Not every name in a sector moves identically.
    effects = assets.flatMap((a, i) => (a.sector === sector ? [{ asset: i, pct: impact * between(next, 0.75, 1.25) }] : []));
  } else if (t.scope === 'market') {
    effects = assets.map((a, i) => ({ asset: i, pct: impact * a.beta }));
  } else {
    target = t.factor!;
    effects = assets.flatMap((a, i) => {
      const s = a.sens[t.factor!] ?? 0;
      return s === 0 ? [] : [{ asset: i, pct: impact * s }];
    });
  }

  const seconds = between(next, t.seconds[0], t.seconds[1]);
  return {
    seq,
    tick,
    template: t.id,
    scope: t.scope,
    target,
    headline: t.headline.replace(/\{(\w+)\}/g, (_, k: string) => fill[k] ?? k),
    description: t.description,
    severity: t.severity,
    duration: Math.max(1, Math.min(Math.round(seconds * ticksPerSecond), maxTick - tick)),
    jump: t.jump,
    persistence: t.persistence,
    effects: effects.map((e) => ({ asset: e.asset, pct: clampPct(e.pct) })),
  };
}

/**
 * The whole session's news, decided up front from the seed. Roughly one event every 7-12% of the
 * session, a market-wide shock somewhere in the middle, and a late twist before the close, so every
 * session has a plot no matter how short it is configured.
 */
export function schedule(seed: number, assets: Asset[], totalTicks: number, tickMs: number): ScheduledEvent[] {
  // A separate stream from the price noise: events never shift which random numbers the prices draw.
  const next = rng(seed ^ 0x5eed_e7e7);
  const ticksPerSecond = 1000 / tickMs;
  const ticks: number[] = [];
  for (let t = totalTicks * 0.06; t < totalTicks * 0.95; t += totalTicks * between(next, 0.07, 0.12)) ticks.push(Math.round(t));

  const closestTo = (frac: number) =>
    ticks.reduce((best, t, i) => (Math.abs(t - totalTicks * frac) < Math.abs(ticks[best]! - totalTicks * frac) ? i : best), 0);
  const shockAt = closestTo(between(next, 0.45, 0.7));
  const twistAt = closestTo(0.9);

  const ordinary = TEMPLATES.filter((t) => t.weight > 0);
  const market = TEMPLATES.filter((t) => t.scope === 'market');
  const strong = ordinary.filter((t) => t.severity >= 2);

  return ticks.map((tick, i) => {
    const t =
      i === shockAt ? market[Math.floor(next() * market.length)]! : i === twistAt ? pickWeighted(next, strong) : pickWeighted(next, ordinary);
    return instantiate(t, assets, next, i + 1, tick, ticksPerSecond, totalTicks);
  });
}
