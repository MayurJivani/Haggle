// The live price layer. One shared cache per instrument, fed by provider streams for the most-watched
// instruments and by polling for the rest. Only instruments something needs are priced: open charts,
// watchlists of connected players, held positions, working orders and the overview's indices.
import type { Logger } from 'pino';
import type { Sql } from '../db/db.js';
import { EXCHANGES, exchangeStatus, type ExchangeId } from './calendar.js';
import type { Catalogue } from './catalogue.js';
import { FX, toScaled } from './ledger.js';
import type { Feeds } from './providers/feeds.js';
import type { Stream } from './providers/provider.js';
import type { Instrument, PriceStatus, Quote } from './types.js';

/** How often each kind of interest is re-polled while its exchange trades. */
const POLL_MS = { viewed: 5_000, held: 30_000, background: 60_000 } as const;
type Priority = keyof typeof POLL_MS;
const PERSIST_MS = 30_000;
const MAX_PER_CYCLE = 200;

export interface MarketOptions {
  maxQuoteAgeMs: number;
  now: () => number;
}

/** Currency units per euro, scaled by FX. LSE quotes in pence (GBp, GBX): 100 pence per pound. */
export function fxScaled(rates: Map<string, string>, currency: string): bigint | null {
  if (currency === 'EUR') return FX;
  const minor = currency === 'GBp' || currency === 'GBX';
  const r = rates.get(minor ? 'GBP' : currency);
  if (!r) return null;
  return toScaled(r, FX) * (minor ? 100n : 1n);
}

/** What to say about a quote right now: its own quality while it is fresh, else stale, closed or none. */
export function priceStatus(q: Quote | undefined, exchange: ExchangeId, now: number, maxAgeMs: number): PriceStatus {
  if (!q) return 'none';
  const s = exchangeStatus(exchange, now).state;
  if (s === 'closed' || s === 'holiday' || s === 'break') return 'closed';
  // A delayed feed is old by design; it goes stale only when it is older than its delay plus the limit.
  if (now - q.at - q.delayMin * 60_000 > maxAgeMs) return 'stale';
  return q.quality;
}

export class Market {
  readonly quotes = new Map<number, Quote>();
  readonly rates = new Map<string, string>();
  ratesAsOf: string | null = null;
  /** Socket refcounts per instrument, and instruments the game needs whoever is watching. */
  private viewers = new Map<number, number>();
  private held = new Set<number>();
  private background = new Set<number>();
  private polledAt = new Map<number, number>();
  private dirty = new Set<number>();
  private streams = new Map<string, Stream>();
  private listeners = new Set<(qs: Quote[]) => void>();
  private pending = new Map<number, Quote>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private polling = false;
  private stopped = false;

  constructor(private sql: Sql, private catalogue: Catalogue, private feeds: Feeds, private log: Logger, private opt: MarketOptions) {}

  async start() {
    const rows = await this.sql<{ quote: Quote }[]>`SELECT quote FROM rt_quotes`;
    for (const r of rows) this.quotes.set(r.quote.id, r.quote);
    const fx = await this.sql<{ currency: string; per_eur: string; as_of: Date }[]>`SELECT currency, per_eur::text, as_of FROM rt_fx`;
    for (const r of fx) this.rates.set(r.currency, r.per_eur);
    this.ratesAsOf = fx[0]?.as_of.toISOString().slice(0, 10) ?? null;
    for (const p of this.feeds.list) {
      if (p.stream) this.streams.set(p.id, p.stream((q) => this.merge(q)));
    }
    this.timers.push(setInterval(() => void this.poll(), 2_000));
    this.timers.push(setInterval(() => this.flush(), 500));
    this.timers.push(setInterval(() => void this.persist(), PERSIST_MS));
    this.timers.push(setInterval(() => void this.resubscribe(), 10_000));
    for (const t of this.timers) t.unref();
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const s of this.streams.values()) s.close();
    await this.persist();
  }

  onQuotes(fn: (qs: Quote[]) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- interest

  view(ids: number[], delta: 1 | -1) {
    for (const id of ids) {
      const n = (this.viewers.get(id) ?? 0) + delta;
      if (n > 0) this.viewers.set(id, n);
      else this.viewers.delete(id);
      // A new viewer gets a fresh price at once rather than waiting for its turn.
      if (delta === 1 && n === 1) this.polledAt.delete(id);
    }
  }
  setHeld(ids: Iterable<number>) {
    this.held = new Set(ids);
  }
  setBackground(ids: Iterable<number>) {
    this.background = new Set(ids);
  }
  viewerCount(id: number) {
    return this.viewers.get(id) ?? 0;
  }
  mostViewed(n: number): number[] {
    return [...this.viewers].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
  }

  // ---------------------------------------------------------------- quotes

  quote(id: number): Quote | undefined {
    return this.quotes.get(id);
  }
  status(i: Instrument): PriceStatus {
    return priceStatus(this.quotes.get(i.id), i.exchange, this.opt.now(), this.opt.maxQuoteAgeMs);
  }
  fx(currency: string) {
    return fxScaled(this.rates, currency);
  }

  /** Folds a partial update (a stream trade or quote) into the cached quote; older updates are ignored. */
  merge(u: Partial<Quote> & { id: number; at: number }) {
    const prev = this.quotes.get(u.id);
    if (prev && u.at < prev.at) return;
    const base: Quote = prev ?? {
      id: u.id, last: null, bid: null, ask: null, bidSize: null, askSize: null, open: null, high: null, low: null, prevClose: null, volume: null,
      at: u.at, quality: 'realtime', delayMin: 0, source: 'stream',
    };
    const q: Quote = { ...base, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null && v !== undefined)), at: u.at };
    if (u.last) {
      q.high = Math.max(q.high ?? u.last, u.last);
      q.low = Math.min(q.low ?? u.last, u.last);
    }
    this.set(q);
  }

  private set(q: Quote) {
    this.quotes.set(q.id, q);
    this.dirty.add(q.id);
    this.pending.set(q.id, q);
  }

  /** Replaces quotes with polled ones (a full snapshot), keeping a newer streamed price if one arrived. */
  private accept(qs: Quote[]) {
    for (const q of qs) {
      const prev = this.quotes.get(q.id);
      if (prev && prev.at > q.at) {
        this.set({ ...q, last: prev.last ?? q.last, bid: prev.bid ?? q.bid, ask: prev.ask ?? q.ask, at: prev.at });
      } else this.set(q);
    }
  }

  private flush() {
    if (!this.pending.size) return;
    const qs = [...this.pending.values()];
    this.pending.clear();
    for (const fn of this.listeners) {
      try {
        fn(qs);
      } catch (err) {
        this.log.error({ err }, 'quote listener failed');
      }
    }
  }

  /** Fetches now, for an order or a page that cannot wait for the next poll. */
  async refresh(list: Instrument[]): Promise<void> {
    const qs = await this.feeds.quotes(list);
    const t = this.opt.now();
    for (const i of list) this.polledAt.set(i.id, t);
    this.accept(qs);
  }

  private priority(id: number): Priority | null {
    if (this.viewers.has(id)) return 'viewed';
    if (this.held.has(id)) return 'held';
    if (this.background.has(id)) return 'background';
    return null;
  }

  private async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const t = this.opt.now();
      const ids = new Set([...this.viewers.keys(), ...this.held, ...this.background]);
      const due: { id: number; p: Priority }[] = [];
      for (const id of ids) {
        const p = this.priority(id)!;
        const last = this.polledAt.get(id);
        if (last === undefined || t - last >= POLL_MS[p]) due.push({ id, p });
      }
      if (!due.length) return;
      const order: Priority[] = ['viewed', 'held', 'background'];
      due.sort((a, b) => order.indexOf(a.p) - order.indexOf(b.p));
      const list = await this.catalogue.many(due.slice(0, MAX_PER_CYCLE).map((d) => d.id));
      // Outside every session a price cannot change: one poll for the last close, then nothing until it opens.
      const live = list.filter((i) => {
        const s = exchangeStatus(i.exchange, t).state;
        return s === 'open' || s === 'pre' || s === 'post' || !this.quotes.has(i.id);
      });
      for (const i of list) this.polledAt.set(i.id, t);
      if (live.length) this.accept(await this.feeds.quotes(live));
    } catch (err) {
      this.log.warn({ err }, 'quote poll failed');
    } finally {
      this.polling = false;
    }
  }

  /** Gives each provider's stream its most-watched instruments that are trading; the rest are polled. */
  private async resubscribe() {
    if (!this.streams.size) return;
    const t = this.opt.now();
    const ranked = [...new Set([...this.mostViewed(1000), ...this.held])];
    const list = await this.catalogue.many(ranked);
    for (const [pid, stream] of this.streams) {
      const mine = list.filter((i) => {
        if (this.feeds.for(i)?.id !== pid) return false;
        const s = exchangeStatus(i.exchange, t).state;
        return s === 'open' || s === 'pre' || s === 'post';
      });
      stream.set(mine.slice(0, stream.max));
    }
  }

  streamUp(): Record<string, boolean> {
    return Object.fromEntries([...this.streams].map(([id, s]) => [id, s.up]));
  }

  private async persist() {
    if (!this.dirty.size) return;
    const rows = [...this.dirty].flatMap((id) => {
      const q = this.quotes.get(id);
      return q ? [{ instrument_id: id, quote: q, at: new Date(q.at) }] : [];
    });
    this.dirty.clear();
    try {
      for (let k = 0; k < rows.length; k += 500) {
        const chunk = rows.slice(k, k + 500);
        await this.sql`
          INSERT INTO rt_quotes (instrument_id, quote, at)
          SELECT x.id, x.q, x.at FROM jsonb_to_recordset(${this.sql.json(chunk.map((r) => ({ id: r.instrument_id, q: r.quote, at: r.at.toISOString() })) as never)})
            AS x(id bigint, q jsonb, at timestamptz)
          ON CONFLICT (instrument_id) DO UPDATE SET quote = EXCLUDED.quote, at = EXCLUDED.at WHERE rt_quotes.at <= EXCLUDED.at`;
      }
    } catch (err) {
      for (const r of rows) this.dirty.add(r.instrument_id);
      this.log.warn({ err }, 'quote persist failed');
    }
  }

  /** ECB reference rates (Frankfurter). Kept in the database so a restart without network still values portfolios. */
  async syncFx(): Promise<void> {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR', { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`fx ${r.status}`);
    const body = (await r.json()) as { date: string; rates: Record<string, number> };
    const rows = Object.entries(body.rates).filter(([, v]) => v > 0).map(([currency, v]) => ({ currency, per_eur: String(v), as_of: body.date }));
    if (!rows.length) return;
    await this.sql`
      INSERT INTO rt_fx ${this.sql(rows, 'currency', 'per_eur', 'as_of')}
      ON CONFLICT (currency) DO UPDATE SET per_eur = EXCLUDED.per_eur, as_of = EXCLUDED.as_of`;
    for (const x of rows) this.rates.set(x.currency, x.per_eur);
    this.ratesAsOf = body.date;
  }

  /** Test hook: sets a quote as if a provider had sent it. */
  inject(q: Quote) {
    this.set(q);
    this.flush();
  }
}

export const exchangesTrading = (now: number) =>
  (Object.keys(EXCHANGES) as ExchangeId[]).filter((id) => ['open', 'pre', 'post'].includes(exchangeStatus(id, now).state));
