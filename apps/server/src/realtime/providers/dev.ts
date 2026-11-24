// DEVELOPMENT ONLY. Generated prices for working on RealTime without API keys and for automated tests.
// Every quote it makes is labelled quality 'dev' and the UI says so on every screen; env.ts refuses it
// when NODE_ENV=production. Prices are a deterministic function of the instrument and the time.
import { EXCHANGES, type ExchangeId, sessionsOn, zoned } from '../calendar.js';
import type { Candle, Instrument, NewsItem, Quote } from '../types.js';
import type { Provider, Resolution, Stream } from './provider.js';

const STEP: Record<Resolution, number> = { '1min': 60e3, '5min': 300e3, '15min': 900e3, '1h': 3600e3, '1day': 86400e3, '1week': 7 * 86400e3, '1month': 30 * 86400e3 };

function hash(n: number) {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Price units (1/10,000) at time t. */
export function devPrice(id: number, t: number): number {
  const base = 10 + hash(id) * 490;
  const m = Math.floor(t / 60_000);
  const v = 1 + 0.08 * Math.sin(t / 86_400_000 / 9 + id) + 0.02 * Math.sin(t / 3_600_000 + id * 3) + 0.004 * (hash(id * 7919 + m) - 0.5);
  return Math.round(base * v * 10_000);
}

export class Dev implements Provider {
  readonly id = 'dev';
  readonly label = 'Development data (generated, not real)';
  readonly exchanges = Object.keys(EXCHANGES) as ExchangeId[];
  constructor(private now: () => number) {}

  covers() {
    return true;
  }
  quality() {
    return { quality: 'dev' as const, delayMin: 0 };
  }

  async quotes(list: Instrument[]): Promise<Quote[]> {
    const t = this.now();
    return list.map((i) => {
      const last = devPrice(i.id, t);
      const day = sessionsOn(EXCHANGES[i.exchange], zoned(t, EXCHANGES[i.exchange].tz).date);
      const open = devPrice(i.id, day?.open ?? t - 86_400_000);
      return {
        id: i.id, last, bid: Math.round(last * 0.9998), ask: Math.round(last * 1.0002), bidSize: 300, askSize: 300,
        open, high: Math.max(open, last), low: Math.min(open, last), prevClose: devPrice(i.id, (day?.open ?? t) - 3_600_000 * 8), volume: 1_000_000,
        at: t, quality: 'dev', delayMin: 0, source: this.id,
      };
    });
  }

  async candles(i: Instrument, res: Resolution, from: number, to: number): Promise<Candle[]> {
    const ex = EXCHANGES[i.exchange];
    const step = STEP[res];
    const out: Candle[] = [];
    // Intraday bars only inside the exchange's sessions, like a real feed.
    for (let t = Math.floor(from / step) * step; t < to && out.length < 5000; t += step) {
      if (step < 86_400_000) {
        const s = sessionsOn(ex, zoned(t, ex.tz).date);
        if (!s || t < s.open || t >= s.close) continue;
      }
      const o = devPrice(i.id, t);
      const c = devPrice(i.id, Math.min(t + step, to) - 1);
      out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 10_000 });
    }
    return out;
  }

  async news(): Promise<NewsItem[]> {
    return [];
  }

  stream(onQuote: (q: Partial<Quote> & { id: number; at: number }) => void): Stream {
    let ids: number[] = [];
    const timer = setInterval(() => {
      const t = this.now();
      for (const id of ids) {
        const last = devPrice(id, t);
        onQuote({ id, at: t, last, bid: Math.round(last * 0.9998), ask: Math.round(last * 1.0002) });
      }
    }, 2000);
    timer.unref();
    return { max: 500, up: true, set: (list) => void (ids = list.map((i) => i.id)), close: () => clearInterval(timer) };
  }
}
