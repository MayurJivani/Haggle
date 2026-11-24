import type { ExchangeId } from '../calendar.js';
import type { Candle, FeedInfo, Instrument, NewsItem, Quote } from '../types.js';
import type { Movers, Provider, ProviderAction, ProviderDay, Resolution } from './provider.js';

/** A provider that failed sits out this long before it is tried first again. */
const COOL_OFF_MS = 60_000;

/**
 * Routes each instrument to the first configured provider that covers its exchange, falling back down
 * the list when one fails. Order is the operator's (REALTIME_PROVIDERS), so the better feed goes first.
 */
export class Feeds {
  private downUntil = new Map<string, number>();
  private detail = new Map<string, string>();

  constructor(readonly list: Provider[]) {}

  private candidates(i: Instrument): Provider[] {
    const all = this.list.filter((p) => p.covers(i));
    const now = Date.now();
    return [...all.filter((p) => (this.downUntil.get(p.id) ?? 0) <= now), ...all.filter((p) => (this.downUntil.get(p.id) ?? 0) > now)];
  }

  /** The provider an instrument is priced by right now, if any. */
  for(i: Instrument): Provider | undefined {
    return this.candidates(i)[0];
  }

  private fail(p: Provider, err: unknown) {
    this.downUntil.set(p.id, Date.now() + COOL_OFF_MS);
    this.detail.set(p.id, err instanceof Error ? err.message.slice(0, 160) : String(err));
  }
  private ok(p: Provider) {
    this.downUntil.delete(p.id);
    this.detail.delete(p.id);
  }

  /** Latest quotes from whichever provider answers. Instruments nobody covers are left out, never guessed. */
  async quotes(list: Instrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    let left = list;
    for (let round = 0; round < this.list.length && left.length; round++) {
      const groups = new Map<Provider, Instrument[]>();
      for (const i of left) {
        const p = this.candidates(i)[round];
        if (p) groups.set(p, [...(groups.get(p) ?? []), i]);
      }
      const failed: Instrument[] = [];
      await Promise.all([...groups].map(async ([p, group]) => {
        try {
          out.push(...(await p.quotes(group)));
          this.ok(p);
        } catch (err) {
          this.fail(p, err);
          failed.push(...group);
        }
      }));
      left = failed;
    }
    return out;
  }

  async candles(i: Instrument, res: Resolution, from: number, to: number): Promise<{ candles: Candle[]; provider: Provider } | null> {
    for (const p of this.candidates(i)) {
      try {
        const candles = await p.candles(i, res, from, to);
        this.ok(p);
        return { candles, provider: p };
      } catch (err) {
        this.fail(p, err);
      }
    }
    return null;
  }

  private async first<T>(pick: (p: Provider) => (() => Promise<T>) | undefined): Promise<T | null> {
    for (const p of this.list) {
      const fn = pick(p);
      if (!fn) continue;
      try {
        return await fn();
      } catch (err) {
        this.fail(p, err);
      }
    }
    return null;
  }

  news(list: Instrument[], limit: number): Promise<NewsItem[] | null> {
    return this.first((p) => p.news && (list.length === 0 || list.some((i) => p.covers(i))) ? () => p.news!(list.filter((i) => p.covers(i)), limit) : undefined);
  }
  movers(): Promise<Movers | null> {
    return this.first((p) => p.movers && (() => p.movers!()));
  }
  calendar(ex: ExchangeId, from: string, to: string): Promise<ProviderDay[] | null> {
    return this.first((p) => p.calendar && p.exchanges.includes(ex) ? () => p.calendar!(ex, from, to) : undefined);
  }
  corporateActions(list: Instrument[], from: string, to: string): Promise<ProviderAction[] | null> {
    return this.first((p) => p.corporateActions && list.some((i) => p.covers(i)) ? () => p.corporateActions!(list.filter((i) => p.covers(i)), from, to) : undefined);
  }

  info(): FeedInfo['providers'] {
    const now = Date.now();
    return this.list.map((p) => ({
      id: p.id, label: p.label, exchanges: p.exchanges,
      quality: Object.fromEntries(p.exchanges.map((ex) => [ex, p.quality({ exchange: ex } as Instrument).quality])),
      up: (this.downUntil.get(p.id) ?? 0) <= now, detail: this.detail.get(p.id) ?? '',
    }));
  }
}
