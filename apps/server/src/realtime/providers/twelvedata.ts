// Twelve Data: global quotes and history. Which exchanges a key may read, and whether in real time, depends
// on the plan (Basic: US only; Grow adds LSE, Xetra, Euronext, TSX; Pro adds HKEX, SSE, ASX and real-time EU),
// so both are configured rather than assumed. Quotes carry no bid or ask. Docs: https://twelvedata.com/docs
import WebSocket from 'ws';
import type { ExchangeId } from '../calendar.js';
import type { Candle, Instrument, Quote } from '../types.js';
import { getJson, Limiter, num, ProviderError, px, type Provider, type Resolution, type Stream } from './provider.js';

const BASE = 'https://api.twelvedata.com';

interface TdQuote {
  symbol: string;
  open?: string; high?: string; low?: string; close?: string; volume?: string; previous_close?: string;
  timestamp?: number; last_quote_at?: number;
  code?: number; status?: string; message?: string;
}

export class TwelveData implements Provider {
  readonly id = 'twelvedata';
  readonly label = 'Twelve Data';
  private limiter: Limiter;

  constructor(private cfg: { apiKey: string; exchanges: ExchangeId[]; realtime: ExchangeId[]; delayMin: number; perMinute: number; ws: boolean; streamMax: number }) {
    this.limiter = new Limiter(cfg.perMinute);
    // The full WebSocket needs the Pro plan; Basic and Grow only get a trial of eight symbols.
    if (cfg.ws) this.stream = (onQuote) => new TdStream(cfg, onQuote);
  }

  get exchanges() {
    return this.cfg.exchanges;
  }
  covers(i: Instrument) {
    return this.cfg.exchanges.includes(i.exchange);
  }
  quality(i: Instrument) {
    return this.cfg.realtime.includes(i.exchange) ? { quality: 'realtime' as const, delayMin: 0 } : { quality: 'delayed' as const, delayMin: this.cfg.delayMin };
  }

  /** One credit per symbol: the limiter is asked for all of them before the request goes. */
  private async get<T>(path: string, credits: number): Promise<T> {
    await this.limiter.take(credits);
    const body = await getJson<T & { status?: string; code?: number; message?: string }>(this.id, `${BASE}${path}${path.includes('?') ? '&' : '?'}apikey=${this.cfg.apiKey}`);
    if (body.status === 'error') throw new ProviderError(this.id, body.code ?? 500, body.message ?? 'error');
    return body;
  }

  async quotes(list: Instrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    // A batch shares one mic_code, so instruments are grouped by venue.
    const byMic = new Map<string, Instrument[]>();
    for (const i of list) byMic.set(i.mic, [...(byMic.get(i.mic) ?? []), i]);
    for (const [mic, group] of byMic) {
      for (let k = 0; k < group.length; k += 50) {
        const chunk = group.slice(k, k + 50);
        const body = await this.get<TdQuote | Record<string, TdQuote>>(`/quote?symbol=${encodeURIComponent(chunk.map((i) => i.symbol).join(','))}&mic_code=${mic}`, chunk.length);
        const one = chunk.length === 1 ? { [chunk[0]!.symbol]: body as TdQuote } : (body as Record<string, TdQuote>);
        for (const i of chunk) {
          const q = one[i.symbol];
          // The quote's own time is the start of its bar; last_quote_at is when it last changed.
          const at = (q?.last_quote_at ?? q?.timestamp ?? 0) * 1000;
          if (!q || q.status === 'error' || !at) continue;
          out.push({
            id: i.id, last: px(q.close), bid: null, ask: null, bidSize: null, askSize: null,
            open: px(q.open), high: px(q.high), low: px(q.low), prevClose: px(q.previous_close), volume: num(q.volume),
            at, ...this.quality(i), source: this.id,
          });
        }
      }
    }
    return out;
  }

  async candles(i: Instrument, res: Resolution, from: number, to: number): Promise<Candle[]> {
    const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    const body = await this.get<{ values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] }>(
      `/time_series?symbol=${encodeURIComponent(i.symbol)}&mic_code=${i.mic}&interval=${res}&outputsize=5000&timezone=UTC&order=asc&start_date=${encodeURIComponent(iso(from))}&end_date=${encodeURIComponent(iso(to))}`,
      1,
    );
    return (body.values ?? []).flatMap((v) => {
      const t = Date.parse(v.datetime.length === 10 ? `${v.datetime}T00:00:00Z` : `${v.datetime.replace(' ', 'T')}Z`);
      const [o, h, l, c] = [px(v.open), px(v.high), px(v.low), px(v.close)];
      return o && h && l && c && Number.isFinite(t) ? [{ t, o, h, l, c, v: num(v.volume) ?? 0 }] : [];
    });
  }

  stream?: (onQuote: (q: Partial<Quote> & { id: number; at: number }) => void) => Stream;
}

class TdStream implements Stream {
  readonly max: number;
  up = false;
  private ws: WebSocket | null = null;
  private wanted = new Map<string, number>();
  private sent = new Set<string>();
  private retries = 0;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private cfg: { apiKey: string; streamMax: number }, private onQuote: (q: Partial<Quote> & { id: number; at: number }) => void) {
    this.max = cfg.streamMax;
    this.connect();
  }
  set(list: Instrument[]) {
    this.wanted = new Map(list.slice(0, this.max).map((i) => [`${i.symbol}:${i.mic}`, i.id]));
    this.sync();
  }
  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.ws?.close();
  }
  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  private sync() {
    if (!this.up) return;
    const obj = (k: string) => ({ symbol: k.split(':')[0], mic_code: k.split(':')[1] });
    const add = [...this.wanted.keys()].filter((s) => !this.sent.has(s));
    const drop = [...this.sent].filter((s) => !this.wanted.has(s));
    if (drop.length) this.send({ action: 'unsubscribe', params: { symbols: drop.map(obj) } });
    if (add.length) this.send({ action: 'subscribe', params: { symbols: add.map(obj) } });
    this.sent = new Set(this.wanted.keys());
  }
  private connect() {
    const ws = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${this.cfg.apiKey}`);
    this.ws = ws;
    ws.on('open', () => {
      this.up = true;
      this.retries = 0;
      this.sent.clear();
      this.sync();
      this.heartbeat = setInterval(() => this.send({ action: 'heartbeat' }), 10_000);
    });
    ws.on('message', (raw) => {
      let m: { event?: string; symbol?: string; mic_code?: string; price?: number; timestamp?: number; day_volume?: number };
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.event !== 'price' || !m.symbol || !m.timestamp) return;
      const id = this.wanted.get(`${m.symbol}:${m.mic_code}`);
      if (id !== undefined) this.onQuote({ id, at: m.timestamp * 1000, last: px(m.price), ...(m.day_volume ? { volume: m.day_volume } : {}) });
    });
    ws.on('close', () => {
      this.up = false;
      clearInterval(this.heartbeat);
      if (!this.closed) setTimeout(() => this.connect(), Math.min(60_000, 1000 * 2 ** this.retries++));
    });
    ws.on('error', () => {});
  }
}
