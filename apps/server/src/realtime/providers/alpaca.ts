// Alpaca Market Data v2: US stocks and ETFs. The free plan streams the IEX exchange in real time (one
// venue, a few percent of US volume: prices are real trades but thinner than the consolidated tape);
// ALPACA_FEED=sip needs the paid plan. Docs: https://docs.alpaca.markets/docs/about-market-data-api
import WebSocket from 'ws';
import type { ExchangeId } from '../calendar.js';
import type { Candle, Instrument, NewsItem, Quote } from '../types.js';
import { getJson, Limiter, num, px, type Movers, type Provider, type ProviderAction, type ProviderDay, type Resolution, type Stream } from './provider.js';

const DATA = 'https://data.alpaca.markets';
const TRADING = 'https://paper-api.alpaca.markets';
const TIMEFRAME: Record<Resolution, string> = { '1min': '1Min', '5min': '5Min', '15min': '15Min', '1h': '1Hour', '1day': '1Day', '1week': '1Week', '1month': '1Month' };

interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }
interface Snapshot {
  latestTrade?: { p: number; s: number; t: string };
  latestQuote?: { bp: number; bs: number; ap: number; as: number; t: string };
  dailyBar?: Bar;
  prevDailyBar?: Bar;
}

const sym = (i: Instrument) => i.symbol.replace('/', '.');

export class Alpaca implements Provider {
  readonly id = 'alpaca';
  readonly label: string;
  readonly exchanges: ExchangeId[] = ['US'];
  private limiter: Limiter;
  private headers: Record<string, string>;

  constructor(private cfg: { keyId: string; secret: string; feed: 'iex' | 'sip' | 'delayed_sip'; perMinute: number; streamMax: number }) {
    this.headers = { 'APCA-API-KEY-ID': cfg.keyId, 'APCA-API-SECRET-KEY': cfg.secret };
    this.limiter = new Limiter(cfg.perMinute);
    this.label = cfg.feed === 'iex' ? 'Alpaca (IEX exchange, real time)' : cfg.feed === 'sip' ? 'Alpaca (all US exchanges, real time)' : 'Alpaca (US, 15 min delayed)';
  }

  covers(i: Instrument) {
    return i.exchange === 'US' && i.kind !== 'index';
  }
  quality() {
    return this.cfg.feed === 'delayed_sip' ? { quality: 'delayed' as const, delayMin: 15 } : { quality: 'realtime' as const, delayMin: 0 };
  }

  private async get<T>(base: string, path: string): Promise<T> {
    await this.limiter.take();
    return getJson<T>(this.id, base + path, this.headers);
  }

  async quotes(list: Instrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    const q = this.quality();
    for (let k = 0; k < list.length; k += 100) {
      const chunk = list.slice(k, k + 100);
      const body = await this.get<Record<string, Snapshot>>(DATA, `/v2/stocks/snapshots?feed=${this.cfg.feed}&symbols=${encodeURIComponent(chunk.map(sym).join(','))}`);
      for (const i of chunk) {
        const s = body[sym(i)];
        if (!s) continue;
        const t = Math.max(Date.parse(s.latestTrade?.t ?? '') || 0, Date.parse(s.latestQuote?.t ?? '') || 0);
        if (!t) continue;
        out.push({
          id: i.id, last: px(s.latestTrade?.p), bid: px(s.latestQuote?.bp), ask: px(s.latestQuote?.ap),
          bidSize: num(s.latestQuote?.bs), askSize: num(s.latestQuote?.as),
          open: px(s.dailyBar?.o), high: px(s.dailyBar?.h), low: px(s.dailyBar?.l), prevClose: px(s.prevDailyBar?.c), volume: num(s.dailyBar?.v),
          at: t, ...q, source: this.id,
        });
      }
    }
    return out;
  }

  async candles(i: Instrument, res: Resolution, from: number, to: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let token: string | null = null;
    // Split-adjusted, so a chart reads straight across a split.
    const base = `/v2/stocks/${encodeURIComponent(sym(i))}/bars?timeframe=${TIMEFRAME[res]}&adjustment=split&feed=${this.cfg.feed}&limit=10000` +
      `&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
    for (let page = 0; page < 10; page++) {
      const body: { bars: Bar[] | null; next_page_token: string | null } = await this.get(DATA, base + (token ? `&page_token=${token}` : ''));
      for (const b of body.bars ?? []) out.push({ t: Date.parse(b.t), o: px(b.o)!, h: px(b.h)!, l: px(b.l)!, c: px(b.c)!, v: b.v });
      token = body.next_page_token;
      if (!token) break;
    }
    return out.filter((c) => c.o && c.h && c.l && c.c);
  }

  async news(list: Instrument[], limit: number): Promise<NewsItem[]> {
    const body = await this.get<{ news: { id: number; headline: string; summary: string; url: string; source: string; created_at: string; symbols: string[] }[] }>(
      DATA, `/v1beta1/news?limit=${Math.min(50, limit)}&sort=desc${list.length ? `&symbols=${encodeURIComponent(list.map(sym).join(','))}` : ''}`,
    );
    return body.news.filter((n) => n.url).map((n) => ({
      id: `alpaca:${n.id}`, headline: n.headline, summary: n.summary || null, url: n.url, source: n.source, at: Date.parse(n.created_at), symbols: n.symbols,
    }));
  }

  async calendar(ex: ExchangeId, from: string, to: string): Promise<ProviderDay[]> {
    if (ex !== 'US') return [];
    const days = await this.get<{ date: string; open: string; close: string }[]>(TRADING, `/v2/calendar?start=${from}&end=${to}`);
    return days.map((d) => ({ date: d.date, open: d.open, close: d.close }));
  }

  async movers(): Promise<Movers> {
    const [m, a] = await Promise.all([
      this.get<{ gainers: { symbol: string }[]; losers: { symbol: string }[] }>(DATA, '/v1beta1/screener/stocks/movers?top=20'),
      this.get<{ most_actives: { symbol: string }[] }>(DATA, '/v1beta1/screener/stocks/most-actives?by=volume&top=20'),
    ]);
    return { gainers: m.gainers.map((x) => x.symbol), losers: m.losers.map((x) => x.symbol), actives: a.most_actives.map((x) => x.symbol) };
  }

  async corporateActions(list: Instrument[], from: string, to: string): Promise<ProviderAction[]> {
    const out: ProviderAction[] = [];
    for (let k = 0; k < list.length; k += 50) {
      type Split = { symbol: string; old_rate: number; new_rate: number; ex_date: string };
      const body = await this.get<{ corporate_actions: { forward_splits?: Split[]; reverse_splits?: Split[]; cash_dividends?: { symbol: string; rate: number; ex_date: string }[]; name_changes?: { old_symbol: string; new_symbol: string; process_date: string }[] } }>(
        DATA, `/v1/corporate-actions?types=forward_split,reverse_split,cash_dividend,name_change&start=${from}&end=${to}&symbols=${encodeURIComponent(list.slice(k, k + 50).map(sym).join(','))}`,
      );
      const ca = body.corporate_actions;
      for (const s of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) out.push({ symbol: s.symbol, kind: 'split', exDate: s.ex_date, ratioFrom: s.old_rate, ratioTo: s.new_rate });
      for (const d of ca.cash_dividends ?? []) if (px(d.rate)) out.push({ symbol: d.symbol, kind: 'dividend', exDate: d.ex_date, cashAmount: px(d.rate)! });
      for (const n of ca.name_changes ?? []) out.push({ symbol: n.old_symbol, kind: 'symbol_change', exDate: n.process_date, newSymbol: n.new_symbol });
    }
    return out;
  }

  stream(onQuote: (q: Partial<Quote> & { id: number; at: number }) => void): Stream {
    return new AlpacaStream(this.cfg, onQuote);
  }
}

/** One WebSocket, reconnecting with backoff, resubscribing whatever set it was last asked for. */
class AlpacaStream implements Stream {
  readonly max: number;
  up = false;
  private ws: WebSocket | null = null;
  private wanted = new Map<string, number>();
  private sent = new Set<string>();
  private retries = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private cfg: { keyId: string; secret: string; feed: string; streamMax: number }, private onQuote: (q: Partial<Quote> & { id: number; at: number }) => void) {
    this.max = cfg.streamMax;
    this.connect();
  }

  set(list: Instrument[]) {
    this.wanted = new Map(list.slice(0, this.max).map((i) => [sym(i), i.id]));
    this.sync();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private sync() {
    if (!this.up) return;
    const add = [...this.wanted.keys()].filter((s) => !this.sent.has(s));
    const drop = [...this.sent].filter((s) => !this.wanted.has(s));
    if (drop.length) this.send({ action: 'unsubscribe', trades: drop, quotes: drop });
    if (add.length) this.send({ action: 'subscribe', trades: add, quotes: add });
    this.sent = new Set(this.wanted.keys());
  }

  private connect() {
    const feed = this.cfg.feed === 'delayed_sip' ? 'delayed_sip' : this.cfg.feed;
    const ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${feed}`);
    this.ws = ws;
    ws.on('message', (raw) => {
      let msgs: { T: string; msg?: string; code?: number; S?: string; p?: number; s?: number; t?: string; bp?: number; ap?: number; bs?: number; as?: number }[];
      try {
        msgs = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const m of msgs) {
        if (m.T === 'success' && m.msg === 'connected') this.send({ action: 'auth', key: this.cfg.keyId, secret: this.cfg.secret });
        else if (m.T === 'success' && m.msg === 'authenticated') {
          this.up = true;
          this.retries = 0;
          this.sent.clear();
          this.sync();
        } else if (m.T === 'error') {
          // 406 connection limit, 402 auth failed: back off; the router keeps polling meanwhile.
          ws.close();
        } else if (m.S && m.t) {
          const id = this.wanted.get(m.S);
          if (id === undefined) continue;
          const at = Date.parse(m.t);
          if (m.T === 't') onQuote(this.onQuote, { id, at, last: px(m.p) });
          else if (m.T === 'q') onQuote(this.onQuote, { id, at, bid: px(m.bp), ask: px(m.ap), bidSize: num(m.bs), askSize: num(m.as) });
        }
      }
    });
    ws.on('close', () => {
      this.up = false;
      if (this.closed) return;
      this.timer = setTimeout(() => this.connect(), Math.min(60_000, 1000 * 2 ** this.retries++));
    });
    ws.on('error', () => {});
  }
}

const onQuote = (fn: (q: Partial<Quote> & { id: number; at: number }) => void, q: Partial<Quote> & { id: number; at: number }) => {
  if (Number.isFinite(q.at)) fn(q);
};
