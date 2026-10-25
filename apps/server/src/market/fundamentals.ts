// Simulated financial reports and the reference valuation built on them. Reports are generated once,
// deterministically from each company's ticker and scale (assets.ts), and stored; after that the only
// way a report appears is an earnings event. Prices never write reports and reports never set prices:
// the valuation below only moves the slow anchor a price is pulled toward (see sim.ts).

import type { Asset, Sector } from './assets.js';
import { rng } from './rng.js';

export interface Report {
  ticker: string;
  fiscalYear: number;
  /** 1-4. Annual figures are the sum of a fiscal year's four quarters, never stored twice. */
  fiscalQuarter: number;
  periodEnd: string;
  reportedAt: number;
  /** EUR millions. */
  revenue: number;
  netIncome: number;
  /** EUR per share. */
  eps: number;
  /** What the market expected going in; null when there was no consensus. */
  epsEstimate: number | null;
  source: 'simulated';
}

/** The latest seeded quarter. Earnings events add the quarters after it. */
export const SEED_LAST = { fiscalYear: 2026, fiscalQuarter: 2 };
export const SEED_QUARTERS = 12;

const hash = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function nextPeriod(fy: number, fq: number) {
  return fq === 4 ? { fiscalYear: fy + 1, fiscalQuarter: 1 } : { fiscalYear: fy, fiscalQuarter: fq + 1 };
}
const prevPeriod = (fy: number, fq: number) => (fq === 1 ? { fiscalYear: fy - 1, fiscalQuarter: 4 } : { fiscalYear: fy, fiscalQuarter: fq - 1 });
const periodEnd = (fy: number, fq: number) => `${fy}-${String(fq * 3).padStart(2, '0')}-${fq === 1 || fq === 4 ? 31 : 30}`;
const ord = (r: { fiscalYear: number; fiscalQuarter: number }) => r.fiscalYear * 4 + r.fiscalQuarter;

/** Shares outstanding in millions, chosen so the seed price sits at the company's seed multiple. */
export function sharesOf(a: Asset): number {
  const revenue = a.revenueBn * 1000;
  const priceEur = a.base / 100;
  return a.margin > 0 ? (revenue * a.margin) / (priceEur / a.mult) : (revenue * a.mult) / priceEur;
}

const SEASON = [0.97, 1.0, 0.98, 1.05];

/** Twelve quarters of simulated history ending at SEED_LAST, the same on every machine. */
export function seedReports(a: Asset): Report[] {
  const next = rng(hash(a.ticker));
  const shares = sharesOf(a);
  const annual = a.revenueBn * 1000;
  const out: Report[] = [];
  let p = { fiscalYear: SEED_LAST.fiscalYear, fiscalQuarter: SEED_LAST.fiscalQuarter };
  const periods: (typeof p)[] = [];
  for (let k = 0; k < SEED_QUARTERS; k++, p = prevPeriod(p.fiscalYear, p.fiscalQuarter)) periods.unshift(p);
  periods.forEach((per, k) => {
    const yearsBack = (SEED_QUARTERS - 1 - k) / 4;
    const revenue = (annual / 4 / (1 + a.growth) ** yearsBack) * SEASON[per.fiscalQuarter - 1]! * (0.97 + 0.06 * next());
    const margin = a.margin + (next() - 0.5) * (0.006 + Math.abs(a.margin) * 0.12);
    const netIncome = revenue * margin;
    const eps = netIncome / shares;
    const estimate = eps * (1 + (next() - 0.55) * 0.12);
    out.push({
      ticker: a.ticker, ...per, periodEnd: periodEnd(per.fiscalYear, per.fiscalQuarter),
      reportedAt: Date.parse(`${periodEnd(per.fiscalYear, per.fiscalQuarter)}T00:00:00Z`) + 30 * 86_400_000,
      revenue: r2(revenue), netIncome: r2(netIncome), eps: r4(eps), epsEstimate: r4(estimate), source: 'simulated',
    });
  });
  return out;
}

/**
 * The next quarter after `reports`, for an earnings event. Consensus expects last year's same quarter
 * grown at the company's trend; `surprise` is how far actual EPS lands from it (0.08 = 8% beat).
 * `revenueSurprise` lets a beat on profit come with soft sales, or the other way round.
 */
export function nextReport(a: Asset, reports: Report[], surprise: number, revenueSurprise: number, at: number): Report {
  const last = reports.at(-1)!;
  const per = nextPeriod(last.fiscalYear, last.fiscalQuarter);
  const yearAgo = reports.find((r) => r.fiscalYear === per.fiscalYear - 1 && r.fiscalQuarter === per.fiscalQuarter) ?? last;
  const shares = sharesOf(a);
  const revenue = yearAgo.revenue * (1 + a.growth) * (1 + revenueSurprise);
  // A loss-maker's consensus is last year's loss, narrowing with growth; a beat means a smaller loss.
  const expected = yearAgo.eps >= 0 ? yearAgo.eps * (1 + a.growth) : yearAgo.eps * (1 - Math.max(0, a.growth));
  const eps = expected + Math.abs(expected || 0.01) * surprise;
  return {
    ticker: a.ticker, ...per, periodEnd: periodEnd(per.fiscalYear, per.fiscalQuarter), reportedAt: at,
    revenue: r2(revenue), netIncome: r2(eps * shares), eps: r4(eps), epsEstimate: r4(expected), source: 'simulated',
  };
}

export interface Summary {
  /** Trailing twelve-month EPS from the last four consecutive quarters; null when a quarter is missing. */
  epsTtm: number | null;
  revenueTtm: number | null;
  netIncomeTtm: number | null;
  /** Year-on-year change of trailing EPS and revenue; null without eight consecutive quarters or a sign change. */
  epsGrowth: number | null;
  revenueGrowth: number | null;
  latest: { fiscalYear: number; fiscalQuarter: number } | null;
  /** Simulated fair value in cents and how it was reached. */
  fair: Fair | null;
}

export interface Fair {
  cents: number;
  basis: 'earnings' | 'sales';
  /** The multiple applied, and the parts it was built from. */
  multiple: number;
  sectorMultiple: number;
  /** The company's own long-run multiple, blended with the sector's. */
  historicalMultiple: number;
  growthFactor: number;
  riskFactor: number;
}

/** Justified multiples per sector. Configuration, not observed from current prices: a fair value read off
 * live prices would rise whenever prices rise, which is exactly the feedback loop this model must not have. */
export const SECTOR_PE: Record<Sector, number> = {
  Technology: 28, Semiconductors: 28, Healthcare: 21, Finance: 11, Energy: 11, Automotive: 8, Consumer: 24,
  'E-commerce': 32, Telecom: 14, 'Aerospace & Defence': 25, Industrials: 20, Materials: 13, 'Food & Beverage': 21,
  Media: 26, Logistics: 15,
};
export const SECTOR_PS: Record<Sector, number> = {
  Technology: 6, Semiconductors: 5, Healthcare: 4, Finance: 2.5, Energy: 1.1, Automotive: 0.5, Consumer: 2,
  'E-commerce': 3, Telecom: 1.2, 'Aerospace & Defence': 1.8, Industrials: 2, Materials: 1.5, 'Food & Beverage': 2,
  Media: 2.2, Logistics: 0.8,
};
export const VALUATION = {
  /** Multiple uplift per unit of growth, and the growth range it reads. */
  growthWeight: 1.2,
  growthRange: [-0.25, 0.4] as const,
  /** Multiple discount per unit of beta above 1. */
  riskWeight: 0.3,
  /** Sales-based value for a loss-maker is cut by this much: no profits yet is a risk in itself. */
  lossDiscount: 0.5,
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sum = (rs: Report[], k: 'eps' | 'revenue' | 'netIncome') => rs.reduce((s, r) => s + r[k], 0);
const consecutive = (rs: Report[]) => rs.every((r, i) => i === 0 || ord(r) === ord(rs[i - 1]!) + 1);

export function summarize(a: Asset, reports: Report[]): Summary {
  const rs = [...reports].sort((x, y) => ord(x) - ord(y));
  const last4 = rs.slice(-4);
  const prev4 = rs.slice(-8, -4);
  const ttmOk = last4.length === 4 && consecutive(last4);
  const prevOk = ttmOk && prev4.length === 4 && consecutive([...prev4, ...last4]);
  const epsTtm = ttmOk ? r4(sum(last4, 'eps')) : null;
  const revenueTtm = ttmOk ? r2(sum(last4, 'revenue')) : null;
  const growth = (now: number | null, before: number) => (now !== null && now > 0 && before > 0 ? now / before - 1 : null);
  const s: Summary = {
    epsTtm,
    revenueTtm,
    netIncomeTtm: ttmOk ? r2(sum(last4, 'netIncome')) : null,
    epsGrowth: prevOk ? growth(epsTtm, sum(prev4, 'eps')) : null,
    revenueGrowth: prevOk ? growth(revenueTtm, sum(prev4, 'revenue')) : null,
    latest: rs.length ? { fiscalYear: rs.at(-1)!.fiscalYear, fiscalQuarter: rs.at(-1)!.fiscalQuarter } : null,
    fair: null,
  };
  s.fair = fairValue(a, s);
  return s;
}

/**
 * Simulated fair value per share: trailing EPS times a justified P/E, or for a loss-maker, sales per
 * share times a discounted P/S. The justified multiple starts from the geometric mean of the sector's
 * multiple and the company's own long-run one (a payments network is not valued like a bank), then
 * moves up with growth and down with risk.
 * An explainable reference point for players, not a target and not advice.
 */
export function fairValue(a: Asset, s: Pick<Summary, 'epsTtm' | 'revenueTtm' | 'epsGrowth' | 'revenueGrowth'>): Fair | null {
  if (s.epsTtm === null || s.revenueTtm === null) return null;
  const g = clamp(s.epsGrowth ?? s.revenueGrowth ?? 0, ...VALUATION.growthRange);
  const growthFactor = 1 + VALUATION.growthWeight * g;
  const riskFactor = clamp(1 / (1 + VALUATION.riskWeight * (a.beta - 1)), 0.75, 1.15);
  const parts = { growthFactor: r4(growthFactor), riskFactor: r4(riskFactor) };
  if (s.epsTtm > 0) {
    // A company seeded as a loss-maker has no long-run P/E of its own; it is judged on the sector's.
    const own = a.margin > 0 ? a.mult : SECTOR_PE[a.sector];
    const multiple = Math.sqrt(SECTOR_PE[a.sector] * own) * growthFactor * riskFactor;
    return { cents: Math.max(1, Math.round(s.epsTtm * multiple * 100)), basis: 'earnings', multiple: r2(multiple), sectorMultiple: SECTOR_PE[a.sector], historicalMultiple: own, ...parts };
  }
  const own = a.margin > 0 ? SECTOR_PS[a.sector] : a.mult;
  const multiple = Math.sqrt(SECTOR_PS[a.sector] * own) * growthFactor * riskFactor * VALUATION.lossDiscount;
  const salesPerShare = s.revenueTtm / sharesOf(a);
  return { cents: Math.max(1, Math.round(salesPerShare * multiple * 100)), basis: 'sales', multiple: r2(multiple), sectorMultiple: SECTOR_PS[a.sector], historicalMultiple: own, ...parts };
}

/** Simulated-price P/E from trailing EPS. 'N/A' without earnings data, 'N/M' when earnings are zero or negative. */
export function peRatio(priceCents: number, epsTtm: number | null): number | 'N/A' | 'N/M' {
  if (epsTtm === null) return 'N/A';
  if (epsTtm <= 0) return 'N/M';
  return r2(priceCents / 100 / epsTtm);
}
