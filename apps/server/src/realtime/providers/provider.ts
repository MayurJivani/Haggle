import type { ExchangeId } from '../calendar.js';
import type { Candle, Instrument, NewsItem, Quality, Quote } from '../types.js';

export type Resolution = '1min' | '5min' | '15min' | '1h' | '1day' | '1week' | '1month';

/** A day a provider says an exchange trades, local times. */
export interface ProviderDay {
  date: string;
  open: string;
  close: string;
}

export interface ProviderAction {
  symbol: string;
  kind: 'split' | 'dividend' | 'symbol_change';
  exDate: string;
  ratioFrom?: number;
  ratioTo?: number;
  /** Per share, 1/10,000 of the instrument currency. */
  cashAmount?: number;
  newSymbol?: string;
}

export interface Movers {
  gainers: string[];
  losers: string[];
  actives: string[];
}

/** Live updates for a capped set of instruments over one connection. */
export interface Stream {
  readonly max: number;
  readonly up: boolean;
  set(list: Instrument[]): void;
  close(): void;
}

/**
 * One market data source. Quotes and candles are required; everything else is optional and the router
 * falls back to the next provider, or to nothing, when a provider lacks it. Never return made-up data:
 * throw or return an empty list instead.
 */
export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly exchanges: ExchangeId[];
  covers(i: Instrument): boolean;
  quality(i: Instrument): { quality: Quality; delayMin: number };
  quotes(list: Instrument[]): Promise<Quote[]>;
  candles(i: Instrument, res: Resolution, from: number, to: number): Promise<Candle[]>;
  /** Opens a live stream; quotes arrive through onQuote. */
  stream?(onQuote: (q: Partial<Quote> & { id: number; at: number }) => void): Stream;
  news?(list: Instrument[], limit: number): Promise<NewsItem[]>;
  calendar?(ex: ExchangeId, from: string, to: string): Promise<ProviderDay[]>;
  movers?(): Promise<Movers>;
  corporateActions?(list: Instrument[], from: string, to: string): Promise<ProviderAction[]>;
}

/** Token bucket: `perMinute` requests, waiting for a token rather than failing. */
export class Limiter {
  private tokens: number;
  private last = Date.now();
  constructor(private perMinute: number) {
    this.tokens = perMinute;
  }
  async take(n = 1): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
      this.last = now;
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((n - this.tokens) / this.perMinute) * 60_000)));
    }
  }
  /** Whether n tokens are there now, without waiting: background polling skips a round instead of queueing. */
  tryTake(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export class ProviderError extends Error {
  constructor(public provider: string, public status: number, message: string) {
    super(`${provider}: ${message}`);
  }
}

export async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new ProviderError(provider, r.status, `${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return (await r.json()) as T;
}

/** Provider decimals to integer price units (1/10,000), or null for missing and non-positive values. */
export function px(x: unknown): number | null {
  const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10_000) : null;
}
export const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) ? n : null;
};
