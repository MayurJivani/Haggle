// The instrument catalogue: every stock, ETF and index on the supported venues, from Twelve Data's public
// reference lists (no key needed), with US sector, industry and market cap from Nasdaq's screener. Synced
// on boot when empty and once a day after that; nothing about prices lives here.
import type { Logger } from 'pino';
import type { Sql } from '../db/db.js';
import { exchangeOfMic, type ExchangeId } from './calendar.js';
import type { Instrument, Kind } from './types.js';

/** Listing venues synced. IEX and Frankfurt floor re-list other venues' shares, so they are left out. */
export const SYNCED_MICS = ['XNYS', 'XNGS', 'XNMS', 'XNCM', 'XASE', 'ARCX', 'BATS', 'XLON', 'XETR', 'XPAR', 'XAMS', 'XBRU', 'XLIS', 'XJPX', 'XHKG', 'XSHG', 'XSHE', 'XTSE', 'XTSX', 'XASX'];

/** The market overview's indices, by venue and symbol as the reference data names them. */
export const HEADLINE_INDICES: { mic: string; symbol: string; name: string; currency: string }[] = [
  { mic: 'XNYS', symbol: 'SPX', name: 'S&P 500', currency: 'USD' },
  { mic: 'XNGS', symbol: 'IXIC', name: 'Nasdaq Composite', currency: 'USD' },
  { mic: 'XNYS', symbol: 'DJI', name: 'Dow Jones Industrial Average', currency: 'USD' },
  { mic: 'XLON', symbol: 'FTSE', name: 'FTSE 100', currency: 'GBP' },
  { mic: 'XETR', symbol: 'GDAXI', name: 'DAX', currency: 'EUR' },
  { mic: 'XPAR', symbol: 'FCHI', name: 'CAC 40', currency: 'EUR' },
  { mic: 'XJPX', symbol: 'N225', name: 'Nikkei 225', currency: 'JPY' },
  { mic: 'XHKG', symbol: 'HSI', name: 'Hang Seng', currency: 'HKD' },
  { mic: 'XSHG', symbol: '000001', name: 'SSE Composite', currency: 'CNY' },
  { mic: 'XTSE', symbol: 'GSPTSE', name: 'S&P/TSX Composite', currency: 'CAD' },
  { mic: 'XASX', symbol: 'AXJO', name: 'S&P/ASX 200', currency: 'AUD' },
];

const KIND: Record<string, Kind> = {
  'Common Stock': 'stock', REIT: 'reit', 'American Depositary Receipt': 'adr', 'Depositary Receipt': 'adr', 'Global Depositary Receipt': 'adr',
  'Closed-end Fund': 'fund', Trust: 'fund',
};

interface Row {
  id: string | number;
  symbol: string;
  mic: string;
  exchange: string;
  name: string;
  kind: Kind;
  currency: string;
  country: string | null;
  sector: string | null;
  industry: string | null;
  market_cap_usd: number | null;
  logo_url: string | null;
  isin: string | null;
  status: Instrument['status'];
}
const toInstrument = (r: Row): Instrument => ({
  id: Number(r.id), symbol: r.symbol, mic: r.mic, exchange: r.exchange as ExchangeId, name: r.name, kind: r.kind, currency: r.currency, country: r.country,
  sector: r.sector, industry: r.industry, marketCapUsd: r.market_cap_usd, logoUrl: r.logo_url, isin: r.isin, status: r.status,
});
const COLS = 'id, symbol, mic, exchange, name, kind, currency, country, sector, industry, market_cap_usd, logo_url, isin, status';

/** Tradegate's index member pages: DAX, MDAX, SDAX, TecDAX, Euro Stoxx 50. */
const TG_LISTS = ['DE000A1EXRV0', 'DE000A1EXRW8', 'DE000A1EXRX6', 'DE000A1EXRY4', 'EU0009658145'];
const TG_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const COUNTRY: Record<string, string> = {
  DE: 'Germany', FR: 'France', NL: 'Netherlands', BE: 'Belgium', IT: 'Italy', ES: 'Spain', FI: 'Finland', IE: 'Ireland', LU: 'Luxembourg', AT: 'Austria', GB: 'United Kingdom', CH: 'Switzerland', DK: 'Denmark',
};

/** ISIN and name pairs from a Tradegate index page. */
export function parseTradegateList(html: string): { isin: string; name: string }[] {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/href="orderbuch\.php\?isin=([A-Z0-9]{12})"[^>]*>([^<]+)/g)) {
    const name = m[2]!.replace(/&nbsp;/g, ' ').replace(/&([aeiouAEIOU])uml;/g, (_, c: string) => c.normalize('NFD') + '\u0308').normalize('NFC')
      .replace(/&szlig;/g, 'ß').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (name) out.set(m[1]!, name);
  }
  return [...out].map(([isin, name]) => ({ isin, name }));
}

export interface BrowseQuery {
  q?: string;
  exchange?: ExchangeId;
  /** Only exchanges in this set (the ones trading, or the ones shut, right now). */
  exchanges?: ExchangeId[];
  sector?: string;
  kind?: Kind;
  capMin?: number;
  capMax?: number;
  sort: 'cap' | 'symbol' | 'name';
  offset: number;
  limit: number;
}

export class Catalogue {
  private cache = new Map<number, Instrument>();

  constructor(private sql: Sql, private log: Logger, private tdKey: string) {}

  async get(id: number): Promise<Instrument | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const [row] = await this.sql.unsafe<Row[]>(`SELECT ${COLS} FROM rt_instruments WHERE id = $1`, [id]);
    if (!row) return null;
    const i = toInstrument(row);
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(id, i);
    return i;
  }

  async many(ids: number[]): Promise<Instrument[]> {
    const missing = ids.filter((id) => !this.cache.has(id));
    if (missing.length) {
      const rows = await this.sql.unsafe<Row[]>(`SELECT ${COLS} FROM rt_instruments WHERE id = ANY($1::bigint[])`, [missing]);
      for (const r of rows) this.cache.set(Number(r.id), toInstrument(r));
    }
    return ids.flatMap((id) => this.cache.get(id) ?? []);
  }

  forget(id: number) {
    this.cache.delete(id);
  }

  async bySymbol(mic: string, symbol: string): Promise<Instrument | null> {
    const [row] = await this.sql.unsafe<Row[]>(`SELECT ${COLS} FROM rt_instruments WHERE mic = $1 AND symbol = $2`, [mic, symbol]);
    return row ? toInstrument(row) : null;
  }

  /** Search and browse in one query: a symbol match ranks first, then name matches, biggest companies first. */
  async browse(b: BrowseQuery): Promise<{ total: number; items: Instrument[] }> {
    const where: string[] = ["status <> 'delisted'"];
    const args: unknown[] = [];
    const arg = (v: unknown) => (args.push(v), `$${args.length}`);
    let rank = 'NULL::int';
    if (b.q) {
      const q = b.q.toLowerCase();
      const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const exact = arg(q);
      const prefix = arg(`${like}%`);
      const word = arg(`%${like}%`);
      where.push(`(lower(symbol) LIKE ${prefix} OR lower(name) LIKE ${word})`);
      rank = `CASE WHEN lower(symbol) = ${exact} THEN 0 WHEN lower(symbol) LIKE ${prefix} THEN 1 WHEN lower(name) LIKE ${prefix} THEN 2 ELSE 3 END`;
    }
    if (b.exchange) where.push(`exchange = ${arg(b.exchange)}`);
    if (b.exchanges) where.push(`exchange = ANY(${arg(b.exchanges)}::text[])`);
    if (b.sector) where.push(`sector = ${arg(b.sector)}`);
    if (b.kind) where.push(`kind = ${arg(b.kind)}`);
    if (b.capMin !== undefined) where.push(`market_cap_usd >= ${arg(b.capMin)}`);
    if (b.capMax !== undefined) where.push(`market_cap_usd < ${arg(b.capMax)}`);
    const order = b.sort === 'symbol' ? 'symbol' : b.sort === 'name' ? 'name' : "market_cap_usd DESC NULLS LAST, (exchange = 'US') DESC, symbol";
    const sqlText = `SELECT ${COLS}, count(*) OVER () AS total FROM rt_instruments WHERE ${where.join(' AND ')} ORDER BY ${rank}, ${order} LIMIT ${arg(b.limit)} OFFSET ${arg(b.offset)}`;
    const rows = await this.sql.unsafe<(Row & { total: string | number })[]>(sqlText, args as never[]);
    for (const r of rows) this.cache.set(Number(r.id), toInstrument(r));
    return { total: Number(rows[0]?.total ?? 0), items: rows.map(toInstrument) };
  }

  async sectors(): Promise<{ sector: string; count: number }[]> {
    const rows = await this.sql<{ sector: string; count: number }[]>`
      SELECT sector, count(*)::int AS count FROM rt_instruments WHERE sector IS NOT NULL AND status <> 'delisted' GROUP BY sector ORDER BY count DESC`;
    return rows;
  }

  async count(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rt_instruments`;
    return r?.n ?? 0;
  }

  // ---------------------------------------------------------------- sync

  private async td<T>(path: string): Promise<T> {
    const url = `https://api.twelvedata.com${path}${this.tdKey ? `&apikey=${this.tdKey}` : ''}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`twelvedata reference ${r.status}`);
    return (await r.json()) as T;
  }

  private async upsert(rows: { symbol: string; mic: string; exchange: string; name: string; kind: Kind; currency: string; country: string | null }[]) {
    for (let k = 0; k < rows.length; k += 1000) {
      const chunk = rows.slice(k, k + 1000);
      await this.sql`
        INSERT INTO rt_instruments ${this.sql(chunk, 'symbol', 'mic', 'exchange', 'name', 'kind', 'currency', 'country')}
        ON CONFLICT (mic, symbol) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, currency = EXCLUDED.currency, country = EXCLUDED.country,
          status = CASE WHEN rt_instruments.status = 'delisted' THEN 'active' ELSE rt_instruments.status END, updated_at = now()`;
    }
  }

  /** Pulls the reference lists. One venue failing leaves its old rows as they were. */
  async sync(): Promise<number> {
    let total = 0;
    type Ref = { symbol: string; name: string; currency: string; mic_code: string; country: string; type?: string };
    for (const mic of SYNCED_MICS) {
      const exchange = exchangeOfMic(mic);
      if (!exchange) continue;
      try {
        const [stocks, etfs] = await Promise.all([
          this.td<{ data?: Ref[] }>(`/stocks?mic_code=${mic}&format=json`),
          this.td<{ data?: Ref[] }>(`/etfs?mic_code=${mic}&format=json`),
        ]);
        const rows = [
          ...(stocks.data ?? []).flatMap((r) => (KIND[r.type ?? ''] ? [{ r, kind: KIND[r.type!]! }] : [])),
          ...(etfs.data ?? []).map((r) => ({ r, kind: 'etf' as Kind })),
        ].map(({ r, kind }) => ({ symbol: r.symbol, mic, exchange, name: r.name || r.symbol, kind, currency: r.currency, country: r.country || null }));
        const unique = [...new Map(rows.map((r) => [r.symbol, r])).values()];
        await this.upsert(unique);
        // Gone from a list that loaded fine for a week: the listing has ended.
        await this.sql`UPDATE rt_instruments SET status = 'delisted' WHERE mic = ${mic} AND kind <> 'index' AND updated_at < now() - interval '7 days' AND status <> 'delisted'`;
        total += unique.length;
      } catch (err) {
        this.log.warn({ err, mic }, 'catalogue venue sync failed');
      }
    }
    await this.upsert(HEADLINE_INDICES.map((x) => ({ ...x, exchange: exchangeOfMic(x.mic)!, kind: 'index' as Kind, country: null })));
    await this.enrichUs().catch((err) => this.log.warn({ err }, 'nasdaq screener enrichment failed'));
    total += await this.syncTradegate().catch((err) => (this.log.warn({ err }, 'tradegate catalogue sync failed'), 0));
    this.cache.clear();
    this.log.info({ total }, 'catalogue synced');
    return total;
  }

  /**
   * European blue chips quoted in euro on Tradegate, from its index member pages. Tickers come from OpenFIGI
   * (keyless), as the Xetra symbol; a share OpenFIGI cannot name keeps its ISIN as the symbol.
   */
  private async syncTradegate(): Promise<number> {
    const members = new Map<string, string>();
    for (const id of TG_LISTS) {
      const r = await fetch(`https://www.tradegatebsx.com/indizes.php?index=${id}`, { headers: { 'user-agent': TG_UA }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`tradegate list ${r.status}`);
      for (const m of parseTradegateList(new TextDecoder('latin1').decode(await r.arrayBuffer()))) members.set(m.isin, m.name);
    }
    if (!members.size) return 0;
    const isins = [...members.keys()];
    const known = new Map((await this.sql<{ isin: string; symbol: string }[]>`SELECT isin, symbol FROM rt_instruments WHERE mic = 'XGAT' AND isin IS NOT NULL`).map((r) => [r.isin, r.symbol]));
    const ticker = new Map<string, string>();
    const ask = isins.filter((i) => !known.has(i));
    // OpenFIGI without a key: ten ISINs a request, 25 requests a minute.
    for (let k = 0; k < ask.length; k += 10) {
      const batch = ask.slice(k, k + 10);
      const r = await fetch('https://api.openfigi.com/v3/mapping', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(batch.map((idValue) => ({ idType: 'ID_ISIN', idValue, exchCode: 'GY' }))),
      });
      if (r.ok) {
        const body = (await r.json()) as { data?: { ticker: string }[] }[];
        body.forEach((x, n) => x.data?.[0]?.ticker && ticker.set(batch[n]!, x.data[0].ticker));
      }
      await new Promise((res) => setTimeout(res, 2600));
    }
    const rows = isins.map((isin) => ({
      symbol: known.get(isin) ?? ticker.get(isin) ?? isin, isin, mic: 'XGAT', exchange: 'TG', name: members.get(isin)!, kind: 'stock' as Kind,
      currency: 'EUR', country: COUNTRY[isin.slice(0, 2)] ?? null,
    }));
    const unique = [...new Map(rows.map((r) => [r.symbol, r])).values()];
    await this.sql`
      INSERT INTO rt_instruments ${this.sql(unique, 'symbol', 'isin', 'mic', 'exchange', 'name', 'kind', 'currency', 'country')}
      ON CONFLICT (mic, symbol) DO UPDATE SET name = EXCLUDED.name, isin = EXCLUDED.isin, country = EXCLUDED.country,
        status = CASE WHEN rt_instruments.status = 'delisted' THEN 'active' ELSE rt_instruments.status END, updated_at = now()`;
    return unique.length;
  }

  /** Sector, industry and market cap for US listings from Nasdaq's public screener. */
  private async enrichUs() {
    const r = await fetch('https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Haggle)', accept: 'application/json' }, signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`nasdaq screener ${r.status}`);
    const body = (await r.json()) as { data?: { rows?: { symbol: string; sector: string; industry: string; marketCap: string }[] } };
    const rows = (body.data?.rows ?? []).map((x) => ({
      symbol: x.symbol.trim().replace('/', '.'), sector: x.sector || null, industry: x.industry || null,
      cap: Number(x.marketCap) > 0 ? Math.round(Number(x.marketCap)) : null,
    }));
    for (let k = 0; k < rows.length; k += 1000) {
      const chunk = rows.slice(k, k + 1000);
      await this.sql`
        UPDATE rt_instruments i SET sector = v.sector, industry = v.industry, market_cap_usd = v.cap::bigint
        FROM (SELECT * FROM jsonb_to_recordset(${this.sql.json(chunk as never)}) AS x(symbol text, sector text, industry text, cap bigint)) v
        WHERE i.exchange = 'US' AND i.symbol = v.symbol AND i.kind <> 'etf'`;
    }
  }
}
