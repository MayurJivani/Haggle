import type { Asset, Factor, Sector } from './assets.js';
import { nextReport, readoutSurprise, type Report } from './fundamentals.js';
import { between, rng } from './rng.js';

export type Scope = 'asset' | 'sector' | 'basket' | 'market' | 'factor';
export type Category = 'macro' | 'sector' | 'company';

type Vars = Record<string, string>;

export interface EventTemplate {
  id: string;
  category: Category;
  scope: Scope;
  /** For asset and sector scope: only pick targets from these sectors. */
  sectors?: Sector[];
  /** For basket scope: the companies the story is about. */
  basket?: string[];
  factor?: Factor;
  /** Total price impact range as a fraction (0.08 = +8%), before per-asset sensitivity. */
  impact: [number, number];
  severity: 1 | 2 | 3;
  /** How long the move takes to play out, in seconds. */
  seconds: [number, number];
  jump: number;
  persistence: number;
  weight: number;
  /** Earnings events file a new quarterly report: EPS surprise and revenue surprise ranges. */
  report?: { surprise: [number, number]; revenue: [number, number] };
  /** A later development on the same company: one of these templates, some ticks on. */
  followUp?: string[];
  headlines: string[];
  bodies: string[];
  /** Extra figures for the story, drawn from the event's own random stream. */
  vars?: (next: () => number, impact: number) => Vars;
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const bp = (next: () => number, lo: number, hi: number) => String(Math.round(between(next, lo, hi) / 25) * 25);

// {name}, {ticker}, {sector}, {industry} come from the target; anything else from `vars` or the report.
// Copy reports what happened and leaves the consequences to the player: no story names a winner.
export const TEMPLATES: EventTemplate[] = [
  // ---------------------------------------------------------------- macro
  { id: 'rate-hike', category: 'macro', scope: 'factor', factor: 'rates', impact: [-0.021, -0.0105], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.85, weight: 3,
    headlines: ['Central bank raises rates by {bp} basis points to {rate}%', 'Surprise hike: policy rate lifted to {rate}%'],
    bodies: ['Policymakers cited sticky services inflation and signalled that further moves remain on the table. Borrowing costs rise for households and companies; lenders reprice loans faster than deposits.'],
    vars: (n) => ({ bp: bp(n, 25, 50), rate: (3 + n() * 1.5).toFixed(2) }) },
  { id: 'rate-cut', category: 'macro', scope: 'factor', factor: 'rates', impact: [0.0105, 0.021], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.85, weight: 3,
    headlines: ['Central bank cuts rates by {bp} basis points to {rate}%', 'Policy rate lowered to {rate}% as inflation cools'],
    bodies: ['The decision was earlier than most economists expected. Cheaper money lowers the discount on future profits, while banks face thinner lending margins.'],
    vars: (n) => ({ bp: bp(n, 25, 50), rate: (2 + n() * 1.5).toFixed(2) }) },
  { id: 'inflation-hot', category: 'macro', scope: 'factor', factor: 'rates', impact: [-0.0135, -0.006], severity: 1, seconds: [30, 70], jump: 0.4, persistence: 0.7, weight: 2,
    headlines: ['Inflation runs hotter than expected at {cpi}%'],
    bodies: ['Consensus had pencilled in {exp}%. Traders now see a higher chance that rates stay restrictive for longer.'],
    vars: (n) => { const exp = 2.4 + n() * 1.2; return { exp: exp.toFixed(1), cpi: (exp + 0.3 + n() * 0.6).toFixed(1) }; } },
  { id: 'growth-upgrade', category: 'macro', scope: 'factor', factor: 'growth', impact: [0.0075, 0.015], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.8, weight: 2,
    headlines: ['Economists raise this year\'s growth forecast to {g}%'],
    bodies: ['Stronger factory orders and hiring pushed forecasters to revise their outlook up from {was}%. Cyclical businesses tend to feel a turn in the economy first.'],
    vars: (n) => { const was = 0.8 + n(); return { was: was.toFixed(1), g: (was + 0.4 + n() * 0.5).toFixed(1) }; } },
  { id: 'recession-fears', category: 'macro', scope: 'factor', factor: 'growth', impact: [-0.018, -0.009], severity: 2, seconds: [40, 80], jump: 0.4, persistence: 0.8, weight: 2,
    headlines: ['Recession fears grow as output contracts for a second quarter'],
    bodies: ['GDP shrank {g}% on the quarter. Purchasing managers report falling new orders; companies tied to industrial demand and credit quality are under scrutiny.'],
    vars: (n) => ({ g: (0.1 + n() * 0.4).toFixed(1) }) },
  { id: 'euro-strength', category: 'macro', scope: 'factor', factor: 'euro', impact: [-0.0105, -0.0045], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.75, weight: 2,
    headlines: ['Euro climbs to a {m}-month high against the dollar'],
    bodies: ['The single currency is up {pct} this month. A stronger euro shrinks the value of overseas sales when they are translated back for European exporters.'],
    vars: (n) => ({ m: String(6 + Math.floor(n() * 18)), pct: pct1(0.02 + n() * 0.03) }) },
  { id: 'consumer-slump', category: 'macro', scope: 'factor', factor: 'consumer', impact: [-0.018, -0.009], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.8, weight: 2,
    headlines: ['Consumer confidence slumps to a two-year low'],
    bodies: ['The index fell {pts} points. Households say they plan to postpone large purchases and cut back on travel.'],
    vars: (n) => ({ pts: String(4 + Math.floor(n() * 6)) }) },
  { id: 'consumer-boom', category: 'macro', scope: 'factor', factor: 'consumer', impact: [0.009, 0.0165], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.75, weight: 2,
    headlines: ['Retail sales jump {pct} as shoppers return'],
    bodies: ['The strongest month in over a year. Some economists warn that spending this strong could keep inflation, and rates, higher.'],
    vars: (n) => ({ pct: pct1(0.012 + n() * 0.015) }) },
  { id: 'market-panic', category: 'macro', scope: 'market', impact: [-0.0275, -0.015], severity: 3, seconds: [20, 45], jump: 0.6, persistence: 0.5, weight: 0,
    headlines: ['Forced selling sweeps global markets'],
    bodies: ['A large fund is reported to be unwinding leveraged positions. Volatility gauges have spiked and selling is broad across sectors.'] },
  { id: 'market-rally', category: 'macro', scope: 'market', impact: [0.0125, 0.0225], severity: 3, seconds: [30, 60], jump: 0.4, persistence: 0.7, weight: 0,
    headlines: ['Stocks surge on blowout jobs report'],
    bodies: ['Employers added far more jobs than forecast while wage growth cooled. Risk appetite returns across the board.'] },

  // ---------------------------------------------------------------- sector developments
  { id: 'chip-shortage', category: 'sector', scope: 'factor', factor: 'chips', impact: [-0.09, -0.05], severity: 2, seconds: [40, 90], jump: 0.3, persistence: 0.8, weight: 3,
    headlines: ['Fab outage tightens global chip supply'],
    bodies: ['A fire and power cut have halted output at a major foundry for an estimated {w} weeks. Lead times for microcontrollers and power chips stretch further; suppliers report stronger pricing.'],
    vars: (n) => ({ w: String(3 + Math.floor(n() * 6)) }) },
  { id: 'datacenter-capex', category: 'sector', scope: 'factor', factor: 'datacenter', impact: [0.04, 0.08], severity: 2, seconds: [40, 90], jump: 0.35, persistence: 0.8, weight: 3,
    headlines: ['Cloud providers lift data-centre spending plans by {pct}'],
    bodies: ['Combined capital expenditure guidance from the largest cloud operators rose sharply, while supply of advanced accelerators remains constrained. Power and cooling equipment orders are also climbing.'],
    vars: (n) => ({ pct: pct1(0.15 + n() * 0.2) }) },
  { id: 'oil-spike', category: 'sector', scope: 'factor', factor: 'oil', impact: [0.06, 0.12], severity: 2, seconds: [30, 70], jump: 0.5, persistence: 0.7, weight: 3,
    headlines: ['Pipeline outage sends Brent above ${brent} a barrel'],
    bodies: ['Crude rose {pct} in a day as a key export route shut. Jet fuel and diesel followed. Producers\' cash flows and transport companies\' fuel bills move in opposite directions.'],
    vars: (n) => ({ brent: String(88 + Math.floor(n() * 15)), pct: pct1(0.05 + n() * 0.05) }) },
  { id: 'oil-slump', category: 'sector', scope: 'factor', factor: 'oil', impact: [-0.08, -0.04], severity: 2, seconds: [30, 70], jump: 0.5, persistence: 0.7, weight: 2,
    headlines: ['Producers agree to raise output; crude falls {pct}'],
    bodies: ['The surprise supply increase pushes Brent toward ${brent}. Lower fuel costs flow through to airlines, shippers and anyone with a large fleet.'],
    vars: (n) => ({ brent: String(62 + Math.floor(n() * 10)), pct: pct1(0.04 + n() * 0.05) }) },
  { id: 'bank-stress', category: 'sector', scope: 'factor', factor: 'credit', impact: [-0.08, -0.04], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.7, weight: 2,
    headlines: ['Deposit run at a mid-sized lender rattles the banking sector'],
    bodies: ['The lender lost {pct} of deposits in two days before regulators stepped in. Investors are examining funding costs and commercial property exposure across the sector.'],
    vars: (n) => ({ pct: pct1(0.15 + n() * 0.2) }) },
  { id: 'tech-regulation', category: 'sector', scope: 'factor', factor: 'techreg', impact: [-0.07, -0.035], severity: 2, seconds: [30, 70], jump: 0.5, persistence: 0.85, weight: 2,
    headlines: ['Lawmakers advance sweeping digital-markets rules'],
    bodies: ['The draft caps app-store fees, restricts self-preferencing and allows fines of up to {pct} of global revenue. Platforms with large marketplaces face the closest scrutiny.'],
    vars: (n) => ({ pct: String(6 + Math.floor(n() * 5)) + '%' }) },
  { id: 'supply-chain', category: 'sector', scope: 'factor', factor: 'supply', impact: [-0.06, -0.03], severity: 2, seconds: [40, 80], jump: 0.35, persistence: 0.75, weight: 2,
    headlines: ['Shipping lanes disrupted; container rates jump {pct}'],
    bodies: ['Vessels are rerouting around a conflict zone, adding up to two weeks to Asia-Europe voyages. Manufacturers warn of component delays; carriers can charge more for scarcer capacity.'],
    vars: (n) => ({ pct: pct1(0.3 + n() * 0.6) }) },
  { id: 'renewables-push', category: 'sector', scope: 'basket', basket: ['NEE', 'ORSTED', 'SU', 'SIE'], impact: [0.04, 0.09], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.8, weight: 2,
    headlines: ['Governments agree a fast track for grid and renewable projects'],
    bodies: ['Permitting times for wind, solar and transmission projects are to be cut by half, with a {bn} billion euro guarantee fund for developers.'],
    vars: (n) => ({ bn: String(20 + Math.floor(n() * 40)) }) },
  { id: 'defence-budgets', category: 'sector', scope: 'basket', basket: ['RHM', 'LMT', 'SAF', 'AIR'], impact: [0.04, 0.09], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.85, weight: 2,
    headlines: ['Allied governments pledge defence spending of {pct} of GDP'],
    bodies: ['The new target lifts combined budgets by tens of billions a year, with procurement weighted toward air defence, munitions and armoured vehicles.'],
    vars: (n) => ({ pct: (2.5 + n()).toFixed(1) + '%' }) },
  { id: 'pharma-fasttrack', category: 'sector', scope: 'sector', sectors: ['Healthcare'], impact: [0.03, 0.07], severity: 1, seconds: [40, 80], jump: 0.3, persistence: 0.8, weight: 2,
    headlines: ['Regulators fast-track a new class of metabolic treatments'],
    bodies: ['A streamlined review pathway could bring approvals forward by a year. Companies with late-stage programmes in the area stand closest to it; others may face new competition.'] },
  { id: 'sector-frenzy', category: 'sector', scope: 'sector', impact: [0.06, 0.12], severity: 2, seconds: [40, 90], jump: 0.25, persistence: 0.4, weight: 2,
    headlines: ['Retail traders pile into {sector} shares'],
    bodies: ['Options volume in the sector hit a record. Analysts note that none of the companies has changed its guidance.'] },
  { id: 'sector-crackdown', category: 'sector', scope: 'sector', impact: [-0.09, -0.04], severity: 2, seconds: [30, 60], jump: 0.5, persistence: 0.85, weight: 2,
    headlines: ['Regulators announce a pricing review across {sector}'],
    bodies: ['The review will examine pricing, data use and contract terms. Officials say interim measures are possible before it concludes.'] },

  // ---------------------------------------------------------------- company
  { id: 'earnings-beat', category: 'company', scope: 'asset', impact: [0.05, 0.12], severity: 2, seconds: [20, 45], jump: 0.6, persistence: 0.6, weight: 5,
    report: { surprise: [0.05, 0.18], revenue: [0.0, 0.04] },
    headlines: ['{name} beats forecasts: EPS {eps} vs {est} expected', '{name} quarterly profit tops estimates'],
    bodies: ['{period} revenue came in at {rev}, {yoy} year on year. Net income was {ni}. Management kept its full-year outlook.'] },
  { id: 'earnings-miss', category: 'company', scope: 'asset', impact: [-0.13, -0.05], severity: 2, seconds: [20, 45], jump: 0.6, persistence: 0.6, weight: 5,
    report: { surprise: [-0.22, -0.06], revenue: [-0.05, 0.0] },
    headlines: ['{name} misses: EPS {eps} vs {est} expected', '{name} results fall short of estimates'],
    bodies: ['{period} revenue was {rev}, {yoy} year on year. Net income came to {ni}. The company blamed weaker demand and higher costs.'] },
  { id: 'beat-guidance-cut', category: 'company', scope: 'asset', impact: [-0.09, -0.04], severity: 2, seconds: [20, 45], jump: 0.6, persistence: 0.7, weight: 2,
    report: { surprise: [0.03, 0.1], revenue: [0.0, 0.03] },
    headlines: ['{name} posts record profit but trims its outlook'],
    bodies: ['{period} EPS of {eps} beat the {est} consensus and revenue rose {yoy} to {rev}. Management lowered next year\'s growth target, citing a slower order book.'] },
  { id: 'margin-pressure', category: 'company', scope: 'asset', impact: [-0.07, -0.03], severity: 1, seconds: [30, 60], jump: 0.5, persistence: 0.7, weight: 3,
    headlines: ['{name} warns of margin pressure'],
    bodies: ['Rising input and wage costs will weigh on margins for the next two quarters, the finance chief said, without changing sales guidance.'] },
  { id: 'product-launch', category: 'company', scope: 'asset', sectors: ['Technology', 'Semiconductors', 'Automotive', 'Consumer', 'Media', 'E-commerce'], impact: [0.03, 0.08], severity: 1, seconds: [30, 70], jump: 0.3, persistence: 0.75, weight: 4,
    headlines: ['{name} unveils its new flagship line-up'],
    bodies: ['Early reviews are positive and pre-orders are said to be ahead of the previous launch. Pricing was not disclosed for all markets.'] },
  { id: 'exec-exit', category: 'company', scope: 'asset', impact: [-0.07, -0.03], severity: 1, seconds: [20, 40], jump: 0.7, persistence: 0.6, weight: 2,
    headlines: ['{name} chief executive steps down with immediate effect'],
    bodies: ['The board has appointed an interim leader and begun a search. It says the strategy is unchanged.'] },
  { id: 'probe', category: 'company', scope: 'asset', impact: [-0.12, -0.05], severity: 2, seconds: [25, 60], jump: 0.5, persistence: 0.7, weight: 3, followUp: ['probe-cleared', 'probe-fined'],
    headlines: ['Regulators open an investigation into {name}'],
    bodies: ['Authorities are examining sales and accounting practices. The company says it is cooperating fully.'] },
  { id: 'probe-cleared', category: 'company', scope: 'asset', impact: [0.03, 0.07], severity: 1, seconds: [20, 40], jump: 0.6, persistence: 0.8, weight: 0,
    headlines: ['Regulators close the {name} inquiry without action'],
    bodies: ['The investigation found no grounds for enforcement. No fine was imposed.'] },
  { id: 'probe-fined', category: 'company', scope: 'asset', impact: [-0.06, -0.02], severity: 1, seconds: [20, 40], jump: 0.6, persistence: 0.8, weight: 0,
    headlines: ['{name} fined {fine} million euros to settle inquiry'],
    bodies: ['The company admitted no wrongdoing and agreed to change some contract terms.'],
    vars: (n) => ({ fine: String(150 + Math.floor(n() * 900)) }) },
  { id: 'new-competitor', category: 'company', scope: 'asset', impact: [-0.07, -0.03], severity: 1, seconds: [30, 60], jump: 0.4, persistence: 0.8, weight: 2,
    headlines: ['Well-funded rival enters {name}\'s core market'],
    bodies: ['The newcomer is undercutting on price in {industry}. Analysts are split on how much share it can take.'] },
  { id: 'contract-win', category: 'company', scope: 'asset', sectors: ['Industrials', 'Aerospace & Defence', 'Technology', 'Semiconductors', 'Logistics', 'Telecom'], impact: [0.03, 0.08], severity: 1, seconds: [20, 50], jump: 0.5, persistence: 0.85, weight: 3,
    headlines: ['{name} wins a {bn} billion euro multi-year contract'],
    bodies: ['The award is one of the largest in the company\'s recent history and runs over {y} years.'],
    vars: (n) => ({ bn: (0.8 + n() * 4).toFixed(1), y: String(4 + Math.floor(n() * 6)) }) },
  { id: 'contract-loss', category: 'company', scope: 'asset', sectors: ['Industrials', 'Aerospace & Defence', 'Technology', 'Semiconductors', 'Logistics', 'Telecom'], impact: [-0.08, -0.03], severity: 1, seconds: [20, 50], jump: 0.5, persistence: 0.85, weight: 2,
    headlines: ['{name} loses a major customer contract'],
    bodies: ['A large customer is moving the work to a competitor when the current agreement expires next year.'] },
  { id: 'buyback', category: 'company', scope: 'asset', impact: [0.02, 0.05], severity: 1, seconds: [30, 60], jump: 0.4, persistence: 0.85, weight: 2,
    headlines: ['{name} announces a {bn} billion euro share buyback'],
    bodies: ['The company will repurchase stock over the next twelve months, funded from surplus cash.'],
    vars: (n) => ({ bn: (1 + n() * 9).toFixed(1) }) },
  { id: 'takeover-rumour', category: 'company', scope: 'asset', impact: [0.06, 0.12], severity: 2, seconds: [15, 35], jump: 0.7, persistence: 0.4, weight: 2, followUp: ['bid-confirmed', 'talks-collapse'],
    headlines: ['Reports: a rival is preparing a bid for {name}'],
    bodies: ['People familiar with the matter say advisers are working on an offer. Neither company has commented.'] },
  { id: 'bid-confirmed', category: 'company', scope: 'asset', impact: [0.04, 0.09], severity: 2, seconds: [15, 30], jump: 0.7, persistence: 0.9, weight: 0,
    headlines: ['{name} confirms it has received a takeover approach'],
    bodies: ['The board says it is evaluating a preliminary proposal. There is no certainty an offer will be made.'] },
  { id: 'talks-collapse', category: 'company', scope: 'asset', impact: [-0.1, -0.05], severity: 2, seconds: [15, 30], jump: 0.7, persistence: 0.9, weight: 0,
    headlines: ['Takeover talks over {name} collapse'],
    bodies: ['The would-be bidder says it does not intend to make an offer.'] },
  { id: 'drug-approval', category: 'company', scope: 'asset', sectors: ['Healthcare'], impact: [0.06, 0.13], severity: 2, seconds: [20, 40], jump: 0.7, persistence: 0.9, weight: 2,
    headlines: ['{name} wins approval for a new treatment'],
    bodies: ['Regulators cleared the drug for a large patient population. Analysts estimate peak annual sales of up to {bn} billion euros.'],
    vars: (n) => ({ bn: (1 + n() * 5).toFixed(1) }) },
  { id: 'trial-failure', category: 'company', scope: 'asset', sectors: ['Healthcare'], impact: [-0.16, -0.08], severity: 2, seconds: [15, 30], jump: 0.8, persistence: 0.9, weight: 2,
    headlines: ['{name} late-stage trial misses its main goal'],
    bodies: ['The candidate failed to beat placebo on the primary endpoint. The company is reviewing the full data before deciding next steps.'] },
  { id: 'recall', category: 'company', scope: 'asset', sectors: ['Automotive', 'Consumer', 'Food & Beverage'], impact: [-0.07, -0.03], severity: 1, seconds: [20, 50], jump: 0.5, persistence: 0.7, weight: 2,
    headlines: ['{name} recalls products over a safety defect'],
    bodies: ['The recall covers about {k} thousand units. The company has set aside an undisclosed sum to cover the cost.'],
    vars: (n) => ({ k: String(50 + Math.floor(n() * 400)) }) },
];

export interface Effect {
  /** Index into the asset list. */
  asset: number;
  /** Total move as a fraction, after sensitivity. */
  pct: number;
}

export interface Figure {
  label: string;
  value: string;
}

export interface ScheduledEvent {
  /** Order within its competition, 1-based. */
  ord: number;
  /** Ticks after the competition's opening bell. */
  tick: number;
  template: string;
  category: Category;
  scope: Scope;
  target: string | null;
  /** Companies the story names, for linking. Factor and market stories name none. */
  related: string[];
  headline: string;
  body: string;
  figures: Figure[];
  severity: 1 | 2 | 3;
  duration: number;
  jump: number;
  persistence: number;
  effects: Effect[];
  report: Report | null;
}

export interface Context {
  assets: Asset[];
  reports: (asset: number) => Report[];
  ticksPerSecond: number;
  /** Last tick of the competition; no move outlives it. */
  maxTick: number;
  /** Epoch ms of a tick, for report dates. */
  at: (tick: number) => number;
  /**
   * The market's hidden value of a company per share, in cents. Earnings stories read their numbers
   * from it (a beat when the business did better than the last reports showed), and so do the quiet
   * quarterly reports every other company files.
   */
  value?: (asset: number) => number;
}

const pickWeighted = <T extends { weight: number }>(next: () => number, items: T[]): T => {
  let roll = next() * items.reduce((s, i) => s + i.weight, 0);
  for (const item of items) if ((roll -= item.weight) < 0) return item;
  return items[items.length - 1]!;
};
const pick = <T>(next: () => number, xs: T[]): T => xs[Math.floor(next() * xs.length)]!;
const eurM = (m: number) => (Math.abs(m) >= 1000 ? `EUR ${(m / 1000).toFixed(1)}bn` : `EUR ${Math.round(m)}m`);
const eps = (x: number) => `EUR ${x.toFixed(2)}`;
const fill = (s: string, v: Vars) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? k);

/** Gameplay-tuned (docs/calibration.md): company and sector stories at 60% of their template strength. */
export const STORY_SCALE = 0.6;

/** Chance a company or sector story is already priced in: the reaction is muted, or even reversed. */
export const PRICED_IN = 0.15;

export function instantiate(t: EventTemplate, ctx: Context, next: () => number, ord: number, tick: number, forAsset?: number, surprise?: number): ScheduledEvent {
  const { assets } = ctx;
  // Company and sector templates are written at headline strength; scaled so a quarter's worth of stories
  // adds what real news days add, not more (docs/calibration.md). Macro templates are sized directly.
  let impact = between(next, t.impact[0], t.impact[1]) * (t.category === 'macro' ? 1 : STORY_SCALE);
  if (t.category !== 'macro' && next() < PRICED_IN) impact *= between(next, -0.4, 0.3);
  // An earnings reaction scales with how big the surprise was.
  if (surprise !== undefined) impact *= Math.max(0.3, Math.min(1.5, Math.abs(surprise) / 0.1));
  let target: string | null = null;
  let related: string[] = [];
  let effects: Effect[] = [];
  let vars: Vars = {};
  let report: Report | null = null;
  const figures: Figure[] = [];
  // Companies never react identically to the same news.
  const jitter = () => between(next, 0.7, 1.3);

  if (t.scope === 'asset') {
    const pool = assets.map((a, i) => ({ a, i })).filter(({ a }) => !t.sectors || t.sectors.includes(a.sector));
    const { a, i } = forAsset !== undefined ? { a: assets[forAsset]!, i: forAsset } : pick(next, pool);
    target = a.ticker;
    related = [a.ticker];
    vars = { name: a.name, ticker: a.ticker, sector: a.sector, industry: a.industry.toLowerCase() };
    effects = [{ asset: i, pct: impact }];
    if (t.report) {
      const history = ctx.reports(i);
      report = surprise === undefined
        ? nextReport(a, history, between(next, ...t.report.surprise), between(next, ...t.report.revenue), ctx.at(tick))
        : nextReport(a, history, surprise, surprise * 0.3, ctx.at(tick));
      const yearAgo = history.find((r) => r.fiscalYear === report!.fiscalYear - 1 && r.fiscalQuarter === report!.fiscalQuarter);
      const yoy = yearAgo ? report.revenue / yearAgo.revenue - 1 : 0;
      Object.assign(vars, {
        eps: eps(report.eps), est: eps(report.epsEstimate ?? report.eps), rev: eurM(report.revenue), ni: eurM(report.netIncome),
        yoy: `${yoy >= 0 ? 'up' : 'down'} ${pct1(Math.abs(yoy))}`, period: `Q${report.fiscalQuarter} FY${report.fiscalYear}`,
      });
      figures.push(
        { label: 'EPS', value: `${eps(report.eps)} vs ${eps(report.epsEstimate ?? report.eps)} est.` },
        { label: 'Revenue', value: `${eurM(report.revenue)} (${yoy >= 0 ? '+' : '-'}${pct1(Math.abs(yoy))} y/y)` },
        { label: 'Net income', value: eurM(report.netIncome) },
      );
    }
  } else if (t.scope === 'sector') {
    const sectors = [...new Set(assets.map((a) => a.sector))].filter((s) => !t.sectors || t.sectors.includes(s));
    const sector = pick(next, sectors);
    target = sector;
    vars = { sector };
    effects = assets.flatMap((a, i) => (a.sector === sector ? [{ asset: i, pct: impact * jitter() }] : []));
  } else if (t.scope === 'basket') {
    target = null;
    related = t.basket!.filter((tk) => assets.some((a) => a.ticker === tk));
    effects = assets.flatMap((a, i) => (related.includes(a.ticker) ? [{ asset: i, pct: impact * jitter() }] : []));
  } else if (t.scope === 'market') {
    effects = assets.map((a, i) => ({ asset: i, pct: impact * a.beta * jitter() }));
  } else {
    target = t.factor!;
    effects = assets.flatMap((a, i) => {
      const s = a.sens[t.factor!] ?? 0;
      return s === 0 ? [] : [{ asset: i, pct: impact * s * jitter() }];
    });
  }

  if (t.vars) Object.assign(vars, t.vars(next, impact));
  const seconds = between(next, t.seconds[0], t.seconds[1]);
  return {
    ord, tick, template: t.id, category: t.category, scope: t.scope, target, related,
    headline: fill(pick(next, t.headlines), vars),
    body: fill(pick(next, t.bodies), vars),
    figures,
    severity: t.severity,
    duration: Math.max(1, Math.min(Math.round(seconds * ctx.ticksPerSecond), ctx.maxTick - tick)),
    jump: t.jump,
    persistence: t.persistence,
    effects: effects.map((e) => ({ asset: e.asset, pct: Math.max(-0.45, Math.min(0.6, e.pct)) })),
    report,
  };
}

/**
 * A competition's news, decided from its seed when the bell rings and stored before anything is
 * published. Roughly one story every 7-12% of the competition, one market-wide shock in the middle,
 * a strong late twist, and follow-ups to stories that have one.
 */
export function schedule(seed: number, ctx: Context, totalTicks: number): ScheduledEvent[] {
  // A separate stream from the price noise: news never shifts which random numbers the prices draw.
  const next = rng(seed ^ 0x5eed_e7e7);
  const ticks: number[] = [];
  for (let t = totalTicks * 0.05; t < totalTicks * 0.93; t += totalTicks * between(next, 0.07, 0.12)) ticks.push(Math.max(1, Math.round(t)));

  const closestTo = (frac: number) =>
    ticks.reduce((best, t, i) => (Math.abs(t - totalTicks * frac) < Math.abs(ticks[best]! - totalTicks * frac) ? i : best), 0);
  const shockAt = closestTo(between(next, 0.45, 0.7));
  const twistAt = closestTo(0.88);

  const ordinary = TEMPLATES.filter((t) => t.weight > 0);
  const market = TEMPLATES.filter((t) => t.scope === 'market');
  const strong = ordinary.filter((t) => t.severity >= 2);
  // One report per company per competition: a second would be built on a quarter not yet filed.
  const reported = new Set<number>();
  const byId = (id: string) => TEMPLATES.find((x) => x.id === id)!;

  const out: ScheduledEvent[] = [];
  ticks.forEach((tick, i) => {
    let t = i === shockAt ? pick(next, market) : i === twistAt ? pickWeighted(next, strong) : pickWeighted(next, ordinary);
    let ev = instantiate(t, ctx, next, 0, tick);
    if (ctx.value && (t.id === 'earnings-beat' || t.id === 'earnings-miss')) {
      // The quarter's numbers come from how the business has really been doing; beat or miss follows.
      const asset = ev.effects[0]!.asset;
      const surprise = readoutSurprise(ctx.assets[asset]!, ctx.reports(asset), ctx.value(asset)) + between(next, -0.02, 0.02);
      t = byId(surprise >= 0 ? 'earnings-beat' : 'earnings-miss');
      ev = instantiate(t, ctx, next, 0, tick, asset, surprise);
    }
    if (ev.report && reported.has(ev.effects[0]!.asset)) {
      t = byId('margin-pressure');
      ev = instantiate(t, ctx, next, 0, tick, ev.effects[0]!.asset);
    }
    if (ev.report) reported.add(ev.effects[0]!.asset);
    out.push(ev);
    if (t.followUp) {
      const later = tick + Math.round(totalTicks * between(next, 0.12, 0.25));
      if (later < totalTicks * 0.95) out.push(instantiate(byId(pick(next, t.followUp)), ctx, next, 0, later, ev.effects[0]!.asset));
    }
  });
  return out.sort((a, b) => a.tick - b.tick).map((e, k) => ({ ...e, ord: k + 1 }));
}

/**
 * Every company reports every quarter. The companies without an earnings story in this competition
 * (about a quarter) file their results quietly, spread across it like an earnings season: numbers read
 * from the market's hidden value plus a small measurement noise, no headline and no price move of
 * their own (the business they describe has already been moving the price). They travel as scheduled
 * events so a restart replays them exactly; the engine keeps them out of the news feed.
 */
export function quietReports(seed: number, ctx: Context, storied: Set<number>, totalTicks: number): ScheduledEvent[] {
  if (!ctx.value) return [];
  const next = rng(seed ^ 0x9e9047);
  return ctx.assets.flatMap((a, i) => {
    const noise = between(next, -0.02, 0.02);
    const tick = 1 + Math.floor(next() * totalTicks * 0.9);
    if (storied.has(i)) return [];
    const surprise = readoutSurprise(a, ctx.reports(i), ctx.value!(i)) + noise;
    const report = nextReport(a, ctx.reports(i), surprise, surprise * 0.3, ctx.at(tick));
    return [{
      ord: 0, tick, template: QUIET_REPORT, category: 'company' as const, scope: 'asset' as const, target: a.ticker, related: [a.ticker],
      headline: `${a.name} files Q${report.fiscalQuarter} FY${report.fiscalYear} results`,
      body: `EPS ${eps(report.eps)} against ${eps(report.epsEstimate ?? report.eps)} expected, revenue ${eurM(report.revenue)}.`,
      figures: [], severity: 1 as const, duration: 1, jump: 0, persistence: 0, effects: [], report,
    }];
  });
}

/** Template id of a quiet quarterly filing: stored and replayed like any event, never shown as news. */
export const QUIET_REPORT = 'quiet-report';
