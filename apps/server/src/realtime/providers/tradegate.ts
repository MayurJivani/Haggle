// Tradegate BSX (Berlin): euro bid, ask and last for European blue chips from the exchange's own public quote
// endpoint, no key. It is undocumented and has no history, so charts for these stocks stay empty.
// shortcut: unofficial endpoint with no published terms, ask Tradegate before relying on it publicly.
import type { Candle, Instrument, Quote } from '../types.js';
import { Limiter, num, px, type Provider } from './provider.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

/** Tradegate mixes JSON numbers with German strings such as "1 216,40" and "+1,10". */
export function deNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\s\u00a0]/g, '').replace(/^\+/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return s && Number.isFinite(Number(s)) ? Number(s) : null;
}

export function tradegateQuote(id: number, body: Record<string, unknown>, at: number): Quote | null {
  const last = px(deNum(body.last));
  const bid = px(deNum(body.bid));
  const ask = px(deNum(body.ask));
  if (!last && !bid && !ask) return null;
  return {
    id, last, bid, ask, bidSize: num(deNum(body.bidsize)), askSize: num(deNum(body.asksize)),
    open: null, high: px(deNum(body.high)), low: px(deNum(body.low)), prevClose: px(deNum(body.close)), volume: num(deNum(body.stueck)),
    at, quality: 'realtime', delayMin: 0, source: 'tradegate',
  };
}

export class Tradegate implements Provider {
  readonly id = 'tradegate';
  readonly label = 'Tradegate (Berlin, real time)';
  readonly exchanges = ['TG' as const];
  private limiter = new Limiter(120);

  covers(i: Instrument) {
    return i.exchange === 'TG' && !!i.isin;
  }
  quality() {
    return { quality: 'realtime' as const, delayMin: 0 };
  }

  async quotes(list: Instrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const i of list) {
      await this.limiter.take();
      const r = await fetch(`https://www.tradegatebsx.com/refresh.php?isin=${encodeURIComponent(i.isin!)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`tradegate ${r.status}`);
      // The endpoint gives no timestamp: the quote is as of the moment it answered.
      const q = tradegateQuote(i.id, (await r.json()) as Record<string, unknown>, Date.now());
      if (q) out.push(q);
    }
    return out;
  }

  async candles(): Promise<Candle[]> {
    return [];
  }
}
