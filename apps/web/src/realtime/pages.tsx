import { Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Change, Lattice, Pnl } from '../components/chrome';
import { money, pct, signedMoney, tone } from '../lib/format';
import { uuid } from '../lib/uuid';
import { Candles } from './chart';
import {
  api, compact, countdown, HttpError, loadQuotes, price, pushRecent, recent, REJECT_COPY, remember, shares, STATE_LABEL, toast, useLive, useQuotes,
  type Activity, type BoardRow, type Details, type Execution, type ExchangeStatus, type Instrument, type LedgerEntry, type NewsItem, type Order, type Portfolio, type Quote, type Season,
} from './store';
import { DayChange, Link, Panel, Px, Quality, StateBadge, useClock, Virtual, WatchStar } from './ui';

// ---------------------------------------------------------------- shared

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!path) return;
    api<T>(path).then((d) => (setData(d), setError(null)), (e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

const SEASON_KEY = 'haggle:rt:season';
export function useSeason(): [string, (s: string) => void] {
  const [s, setS] = useState(() => localStorage.getItem(SEASON_KEY) ?? 'open');
  return [s, (v: string) => (localStorage.setItem(SEASON_KEY, v), setS(v))];
}

function useInstruments(ids: number[]) {
  useQuotes(ids);
  const instruments = useLive((s) => s.instruments);
  const quotes = useLive((s) => s.quotes);
  return ids.flatMap((id) => (instruments.has(id) ? [{ i: instruments.get(id)!, q: quotes.get(id) }] : []));
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="px-4 py-6 text-sm text-ink-3">{children}</p>;

/** A row of a quote table: ticker, name, last, change, state. */
function QuoteRow({ i, q, compactRow = false }: { i: Instrument; q: Quote | undefined; compactRow?: boolean }) {
  const ex = useLive((s) => s.exchanges.find((e) => e.exchange === i.exchange));
  return (
    <Link to={`/stock/${i.id}`} className="grid h-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-rule/60 px-4 text-sm hover:bg-night-3 sm:grid-cols-[5.5rem_minmax(0,1fr)_7rem_5.5rem_6.5rem]">
      <span className="truncate font-bold">{i.symbol}<span className="block truncate text-xs font-normal text-ink-3 sm:hidden">{i.name}</span></span>
      <span className="hidden truncate text-ink-2 sm:block">{i.name}</span>
      <span className="text-right"><Px v={q?.last ?? null} currency={i.currency} index={i.kind === 'index'} /></span>
      <span className="text-right"><DayChange q={q} /></span>
      {!compactRow && <span className="hidden text-right sm:block"><StateBadge s={ex} /></span>}
    </Link>
  );
}

function QuoteTable({ ids, empty }: { ids: number[]; empty: string }) {
  const rows = useInstruments(ids);
  if (!ids.length) return <Empty>{empty}</Empty>;
  return <div>{rows.map(({ i, q }) => <div key={i.id} className="h-11"><QuoteRow i={i} q={q} /></div>)}</div>;
}

// ---------------------------------------------------------------- overview

export function Overview({ signedIn }: { signedIn: boolean }) {
  const { data } = useLoad<{ indices: Instrument[]; movers: { source: string; gainers: number[]; losers: number[]; actives: number[] }; trending: number[] }>('/overview');
  useEffect(() => void (data && remember(data.indices)), [data]);
  const idx = useInstruments(data?.indices.map((i) => i.id) ?? []);
  const watch = [...useLive((s) => s.watch)];
  const [recentIds] = useState(recent);
  const movers = data?.movers;
  useEffect(() => {
    if (movers) void loadQuotes([...movers.gainers, ...movers.losers, ...movers.actives, ...(data?.trending ?? [])]);
  }, [movers, data?.trending]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <section aria-label="Major indices" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-3 lg:grid-cols-6">
        {idx.map(({ i, q }) => {
          const d = q?.last && q.prevClose ? q.last - q.prevClose : null;
          return (
            <Link key={i.id} to={`/stock/${i.id}`} className="bg-night-2 px-3 py-2.5 hover:bg-night-3">
              <p className="truncate text-xs font-semibold text-ink-2">{i.name}</p>
              <p className="text-lg font-bold"><Px v={q?.last} currency={i.currency} index /></p>
              <p className="flex gap-2 text-xs">
                <span className={`tabular-nums ${tone(d ?? 0)}`}>{d === null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${(Math.abs(d) / 10_000).toFixed(2)}`}</span>
                <DayChange q={q} />
              </p>
              <Quality q={q} i={i} />
            </Link>
          );
        })}
        {data && !idx.length && <p className="col-span-full bg-night-2 p-4 text-sm text-ink-3">Index data appears once the instrument catalogue has synced.</p>}
      </section>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          {signedIn && <PortfolioSummary />}
          <div className="grid gap-4 md:grid-cols-3">
            <Panel title="Top gainers"><Movers ids={movers?.gainers ?? []} /></Panel>
            <Panel title="Top losers"><Movers ids={movers?.losers ?? []} /></Panel>
            <Panel title="Most active"><Movers ids={movers?.actives ?? []} volume /></Panel>
          </div>
          {movers?.source === 'priced' && <p className="-mt-2 text-xs text-ink-3">Movers are ranked among the instruments this server is pricing right now; the configured provider has no market-wide screener.</p>}
          <Panel title="Watchlist" right={<Link to="/watchlist" className="text-xs text-saffron">All</Link>}>
            <QuoteTable ids={watch.slice(0, 8)} empty="Star a stock to watch it here." />
          </Panel>
        </div>
        <div className="grid content-start gap-4">
          <Panel title="Trending on Haggle"><QuoteTable ids={data?.trending.slice(0, 8) ?? []} empty="Nothing is being watched right now." /></Panel>
          <Panel title="Recently viewed"><QuoteTable ids={recentIds.slice(0, 6)} empty="Stocks you open show up here." /></Panel>
          <ActivityFeed />
          <News ids={[]} />
        </div>
      </div>
    </div>
  );
}

function Movers({ ids, volume = false }: { ids: number[]; volume?: boolean }) {
  const rows = useInstruments(ids.slice(0, 8));
  if (!ids.length) return <Empty>No movers yet today.</Empty>;
  return (
    <ul>
      {rows.map(({ i, q }) => (
        <li key={i.id}>
          <Link to={`/stock/${i.id}`} className="flex items-center justify-between gap-2 border-b border-rule/60 px-4 py-2 text-sm hover:bg-night-3">
            <span className="min-w-0"><span className="font-bold">{i.symbol}</span><span className="block truncate text-xs text-ink-3">{i.name}</span></span>
            <span className="text-right">
              <Px v={q?.last} currency={i.currency} className="block" />
              {volume ? <span className="text-xs text-ink-3">{compact(q?.volume)}</span> : <DayChange q={q} />}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PortfolioSummary() {
  const [season] = useSeason();
  const version = useLive((s) => s.version);
  const { data } = useLoad<{ portfolio: Portfolio | null }>(`/portfolio?season=${season}`, [version]);
  usePositionQuotes(data?.portfolio ?? null);
  const p = data?.portfolio;
  if (!p) return null;
  return (
    <Panel title={`Portfolio · ${p.season.name}`} right={<Link to="/portfolio" className="text-xs text-saffron">Open</Link>}>
      <Summary p={p} />
    </Panel>
  );
}

/** The live portfolio refreshes on fills; quotes for held stocks keep its prices moving between refreshes. */
function usePositionQuotes(p: Portfolio | null) {
  useQuotes(p?.positions.map((x) => x.instrument.id) ?? []);
}

function Summary({ p }: { p: Portfolio }) {
  const cells: [string, React.ReactNode][] = [
    ['Total value', <span className="text-xl font-bold">{money(p.value)}</span>],
    ['Cash', <>{money(p.cash - p.reserved)}{p.reserved > 0 && <span className="block text-xs text-ink-3">{money(p.reserved)} held for orders</span>}</>],
    ['Invested', money(p.invested)],
    ['Today', p.dayPnl === null ? <span className="text-ink-3">—</span> : <Pnl cents={p.dayPnl} />],
    ['Total P&L', <Pnl cents={p.value - p.season.startingCash} />],
    ['Return', <Change bps={p.returnBps} />],
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-3 lg:grid-cols-6">
        {cells.map(([k, v]) => (
          <div key={k} className="bg-night-2 px-4 py-3"><dt className="text-xs text-ink-3">{k}</dt><dd className="tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {p.unpriced > 0 && <p className="px-4 py-2 text-xs text-saffron">{p.unpriced} position{p.unpriced > 1 ? 's have' : ' has'} no price right now and {p.unpriced > 1 ? 'are' : 'is'} counted at cost.</p>}
    </div>
  );
}

function ActivityFeed() {
  const { data } = useLoad<{ activity: Activity[] }>('/activity');
  return (
    <Panel title="Player activity">
      {!data?.activity.length && <Empty>Trades by players with a public profile show up here.</Empty>}
      <ul>
        {data?.activity.slice(0, 10).map((a, k) => (
          <li key={k} className="flex items-center gap-2 border-b border-rule/60 px-4 py-2 text-sm">
            <Lattice nickname={a.nickname} size={20} />
            <Link to={`/player/${a.userId}`} className="truncate font-semibold">{a.nickname}</Link>
            <span className={a.side === 'buy' ? 'text-up' : 'text-down'}>{a.side === 'buy' ? 'bought' : 'sold'}</span>
            <Link to={`/stock/${a.instrumentId}`} className="font-bold">{a.symbol}</Link>
            <span className="ml-auto text-xs text-ink-3">{new Date(a.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function News({ ids }: { ids: number[] }) {
  const { data } = useLoad<{ news: NewsItem[]; configured: boolean }>(`/news?ids=${ids.join(',')}`);
  return (
    <Panel title="News">
      {data && !data.configured && <Empty>No news provider is configured on this server.</Empty>}
      {data?.configured && !data.news.length && <Empty>No recent news.</Empty>}
      <ul>
        {data?.news.slice(0, 8).map((n) => (
          <li key={n.id} className="border-b border-rule/60 px-4 py-2.5 last:border-0">
            <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold hover:text-saffron">{n.headline}</a>
            <p className="text-xs text-ink-3">{n.source} · {new Date(n.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}{n.symbols.length ? ` · ${n.symbols.slice(0, 4).join(', ')}` : ''}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------- markets

export function Markets() {
  const exchanges = useLive((s) => s.exchanges);
  const feed = useLive((s) => s.feed);
  const now = useClock();
  return (
    <div className="grid gap-4">
      <Panel title="Exchanges">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>{['Exchange', 'Local time', 'Status', 'Trading date', 'Next change', 'Next open', 'Data'].map((h) => <th key={h} className="px-4 py-2 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {exchanges.map((e: ExchangeStatus) => {
                const p = feed?.providers.find((x) => x.exchanges.includes(e.exchange));
                return (
                  <tr key={e.exchange} className="border-t border-rule/60">
                    <td className="px-4 py-2.5"><span className="font-bold">{e.name}</span><span className="block text-xs text-ink-3">{e.tz}</span></td>
                    <td className="px-4 tabular-nums">{new Intl.DateTimeFormat('en-GB', { timeZone: e.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now)}</td>
                    <td className="px-4"><StateBadge s={e} />{e.note && <span className="block text-xs text-ink-3">{e.note}</span>}{e.early && <span className="block text-xs text-saffron">Early close</span>}</td>
                    <td className="px-4 tabular-nums">{e.tradingDate}</td>
                    <td className="px-4 tabular-nums">{STATE_LABEL[e.state]} {['open', 'pre', 'post', 'break'].includes(e.state) ? 'ends' : 'until open'} in {countdown(e.until - now)}</td>
                    <td className="px-4 tabular-nums">{new Date(e.nextOpen).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="px-4 text-xs">
                      {p ? <span className={p.up ? 'text-ink-2' : 'text-down'}>{p.label}: {p.quality[e.exchange]}</span> : <span className="text-down">No provider: not tradable</span>}
                      {!e.verified && <span className="block text-saffron">Holiday list not yet checked against the exchange</span>}
                      {!e.calendarKnown && <span className="block text-saffron">Holidays past the published calendar are unknown</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      {feed && <ExecutionPolicy />}
    </div>
  );
}

export function ExecutionPolicy() {
  const feed = useLive((s) => s.feed);
  if (!feed) return null;
  const p = feed.policy;
  return (
    <Panel title="How orders fill">
      <ul className="grid gap-1.5 px-4 py-3 text-sm text-ink-2">
        <li>This is paper trading: prices are real, the orders never reach an exchange.</li>
        <li>Market orders fill only in the regular session, buying at the ask and selling at the bid of the latest quote. With no usable quote side (or a spread over {p.maxSpreadBps / 100}%) they use the last trade {p.slippageBps / 100}% against you.</li>
        <li>A quote older than {p.maxQuoteAgeSec} seconds is stale and is never traded on.{p.delayedFills ? '' : ' Delayed and end-of-day prices are shown but cannot be traded on.'}</li>
        <li>Limit orders wait on the server and fill when a newer quote crosses the limit{p.extendedHours ? ', including pre-market and after-hours where the exchange has them' : ''}.{p.partialFills ? ' A fill is capped at the size shown on the quote, so large orders can fill in parts.' : ''}</li>
        <li>Foreign prices convert to euro at the latest ECB reference rate. Splits rescale your shares at the same cost; cash dividends are paid in on the ex-date.</li>
        {feed.providers.map((x) => <li key={x.id} className="text-xs text-ink-3">{x.label}: {x.exchanges.join(', ')} · {x.up ? 'up' : 'failing'} · {x.detail}</li>)}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------- browse

const EXCHANGE_OPTIONS = ['US', 'TG', 'LSE', 'XETRA', 'EURONEXT', 'TSE', 'HKEX', 'SSE', 'TSX', 'ASX'];
const CAP_LABEL: Record<string, string> = { mega: 'Mega (>$200B)', large: 'Large ($10B-200B)', mid: 'Mid ($2B-10B)', small: 'Small ($300M-2B)', micro: 'Micro (<$300M)' };

export function Stocks() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState({ exchange: '', sector: '', kind: '', cap: '', trading: '' });
  const [items, setItems] = useState<Instrument[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const sectors = useLoad<{ sectors: { sector: string; count: number }[] }>('/sectors').data?.sectors ?? [];
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (debounced) p.set('q', debounced);
    for (const [k, v] of Object.entries(filter)) if (v) p.set(k, v);
    return p.toString();
  }, [debounced, filter]);
  const page = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await api<{ total: number; items: Instrument[] }>(`/instruments?${query}&offset=${offset}&limit=100`);
      remember(r.items);
      setTotal(r.total);
      setItems((prev) => (offset ? [...prev, ...r.items] : r.items));
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => void page(0), [page]);
  const more = useCallback(() => {
    if (!loading && items.length < total) void page(items.length);
  }, [loading, items.length, total, page]);
  useQuotes(items.slice(0, 300).map((i) => i.id));
  const quotes = useLive((s) => s.quotes);
  const sel = (k: keyof typeof filter, label: string, opts: [string, string][]) => (
    <label className="flex flex-col gap-1 text-xs text-ink-3">
      {label}
      <select value={filter[k]} onChange={(e) => setFilter({ ...filter, [k]: e.target.value })} className="rounded-md border border-rule bg-night-2 px-2 py-1.5 text-sm text-ink">
        <option value="">All</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  return (
    <Panel>
      <div className="flex flex-wrap items-end gap-3 border-b border-rule p-3">
        <label className="relative min-w-60 flex-1">
          <span className="sr-only">Search by company or ticker</span>
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company or ticker: AAPL, BMW, Toyota" className="w-full rounded-md border border-rule bg-night py-2 pl-9 pr-8 text-sm" />
          {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3"><X size={16} /></button>}
        </label>
        {sel('exchange', 'Exchange', EXCHANGE_OPTIONS.map((x) => [x, x]))}
        {sel('kind', 'Type', [['stock', 'Stocks'], ['etf', 'ETFs'], ['index', 'Indices'], ['adr', 'ADRs'], ['reit', 'REITs'], ['fund', 'Funds']])}
        {sel('sector', 'Sector', sectors.map((s) => [s.sector, s.sector]))}
        {sel('cap', 'Market cap', Object.entries(CAP_LABEL))}
        {sel('trading', 'Session', [['open', 'Trading now'], ['closed', 'Closed now']])}
      </div>
      <p className="px-4 py-2 text-xs text-ink-3">{total.toLocaleString()} instruments{loading ? ' · loading' : ''}{filter.sector || filter.cap ? ' · sector and market cap are known for US listings' : ''}</p>
      <Virtual items={items} height={44} max={620} onEnd={more} row={(i) => <QuoteRow i={i} q={quotes.get(i.id)} />} />
      {!loading && !items.length && <Empty>No instrument matches. The catalogue fills on the first server start; give it a few minutes.</Empty>}
    </Panel>
  );
}

export function Watchlist() {
  const ids = [...useLive((s) => s.watch)];
  return <Panel title="Watchlist"><QuoteTable ids={ids} empty="Your watchlist is empty. Star stocks from their page or from search." /></Panel>;
}

// ---------------------------------------------------------------- instrument

export function Stock({ id, signedIn }: { id: number; signedIn: boolean }) {
  const { data, error } = useLoad<Details>(`/instruments/${id}`);
  useEffect(() => {
    if (data) {
      remember([data.instrument]);
      pushRecent(id);
    }
  }, [data, id]);
  useQuotes([id]);
  const q = useLive((s) => s.quotes.get(id)) ?? data?.quote ?? undefined;
  const ex = useLive((s) => s.exchanges.find((e) => e.exchange === data?.instrument.exchange));
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Loading</Empty>;
  const i = data.instrument;
  const d = q?.last && q.prevClose ? q.last - q.prevClose : null;
  const stats: [string, React.ReactNode][] = [
    ['Bid', q?.bid ? <>{price(q.bid, i.currency)}{q.bidSize ? <span className="text-ink-3"> × {compact(q.bidSize)}</span> : null}</> : '—'],
    ['Ask', q?.ask ? <>{price(q.ask, i.currency)}{q.askSize ? <span className="text-ink-3"> × {compact(q.askSize)}</span> : null}</> : '—'],
    ['Open', price(q?.open, i.currency)],
    ['Previous close', price(q?.prevClose, i.currency)],
    ['Day high', price(q?.high, i.currency)],
    ['Day low', price(q?.low, i.currency)],
    ['Volume', compact(q?.volume)],
    ['Market cap', i.marketCapUsd ? `$${compact(i.marketCapUsd)}` : '—'],
    ['52-week high', price(data.fiftyTwoWeek?.high, i.currency)],
    ['52-week low', price(data.fiftyTwoWeek?.low, i.currency)],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid content-start gap-4">
        <Panel>
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
            {i.logoUrl && <img src={i.logoUrl} alt="" className="size-12 rounded-md bg-ink object-contain p-1" />}
            <div className="min-w-0 sm:flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-3xl font-black uppercase">{i.symbol}</h1>
                <StateBadge s={ex} />
                <span className="rounded-sm border border-rule px-1.5 py-0.5 text-[11px] uppercase text-ink-2">{i.kind}</span>
                {i.status !== 'active' && <span className="rounded-sm bg-down-deep px-1.5 py-0.5 text-[11px] font-bold uppercase text-down">{i.status}</span>}
                <WatchStar id={i.id} />
              </div>
              <p className="truncate text-ink-2">{i.name}</p>
              <p className="text-xs text-ink-3">{ex?.name ?? i.exchange} ({i.mic}) · {i.currency}{i.sector ? ` · ${i.sector}` : ''}{i.industry ? ` · ${i.industry}` : ''}</p>
            </div>
            <div className="sm:text-right">
              <p className="text-3xl font-bold"><Px v={q?.last} currency={i.currency} index={i.kind === 'index'} /></p>
              <p className="flex gap-2 text-sm sm:justify-end">
                <span className={`tabular-nums ${tone(d ?? 0)}`}>{d === null ? '' : `${d > 0 ? '+' : '−'}${price(Math.abs(d), i.currency)}`}</span>
                <DayChange q={q} />
              </p>
              <Quality q={q} i={i} long />
            </div>
          </div>
          {!data.covered && <p className="border-t border-rule px-4 py-2 text-sm text-saffron">No configured data provider covers {ex?.name ?? i.exchange}: this instrument has no price here and cannot be traded.</p>}
          <dl className="grid grid-cols-2 gap-px border-t border-rule bg-rule sm:grid-cols-5">
            {stats.map(([k, v]) => <div key={k} className="bg-night-2 px-4 py-2"><dt className="text-xs text-ink-3">{k}</dt><dd className="text-sm tabular-nums">{v}</dd></div>)}
          </dl>
          <Candles i={i} q={q} />
        </Panel>
        <News ids={[i.id]} />
      </div>
      <div className="grid content-start gap-4">
        {i.kind === 'index'
          ? <Panel title="Trade"><Empty>Indices cannot be bought. Search for an ETF that tracks the {i.name}.</Empty></Panel>
          : signedIn ? <TradePanel i={i} q={q} ex={ex} /> : <Panel title="Trade"><Empty><a href="/play" className="text-saffron">Pick a nickname</a> to trade with virtual cash.</Empty></Panel>}
      </div>
    </div>
  );
}

function TradePanel({ i, q, ex }: { i: Instrument; q: Quote | undefined; ex: ExchangeStatus | undefined }) {
  const [season] = useSeason();
  const version = useLive((s) => s.version);
  const feed = useLive((s) => s.feed);
  const { data } = useLoad<{ portfolio: Portfolio | null }>(`/portfolio?season=${season}`, [version]);
  const p = data?.portfolio;
  const pos = p?.positions.find((x) => x.instrument.id === i.id);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [by, setBy] = useState<'shares' | 'amount'>('shares');
  const [qtyText, setQty] = useState('1');
  const [limitText, setLimit] = useState('');
  const [queue, setQueue] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const minor = i.currency === 'GBp' || i.currency === 'GBX';

  const open = ex?.state === 'open';
  const extended = (ex?.state === 'pre' || ex?.state === 'post') && feed?.policy.extendedHours;
  const qtyMicro = Math.round(Number(qtyText) * 1_000_000);
  const amountCents = Math.round(Number(qtyText) * 100);
  const limitUnits = Math.round(Number(limitText) * 10_000);
  const ref = type === 'limit' ? limitUnits : side === 'buy' ? (q?.ask ?? q?.last) : (q?.bid ?? q?.last);
  const fx = useFx(i.currency);
  const estimate = ref && fx ? (by === 'amount' && type === 'market' ? amountCents : Math.round(((qtyMicro / 1_000_000) * (ref / 10_000) * 100) / fx)) : null;
  const tradableNow = type === 'market' ? open : open || extended || queue;

  const submit = async () => {
    if (!review) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        clientOrderId: review, instrumentId: i.id, side, type,
        ...(by === 'amount' && type === 'market' && side === 'buy' ? { amount: amountCents } : { qty: qtyMicro }),
        ...(type === 'limit' ? { limitPrice: limitUnits, queue } : {}),
      };
      const r = await api<{ order: Order; execution?: Execution }>(`/orders?season=${season}`, { method: 'POST', json: body });
      if (!r.execution) toast(`${type === 'limit' ? 'Limit order' : 'Order'} placed: ${side} ${shares(r.order.qty)} ${i.symbol}`, 'info');
      setReview(null);
    } catch (e) {
      const reason = e instanceof HttpError ? e.body.reason ?? '' : '';
      setErr(REJECT_COPY[reason] ?? (e as Error).message);
      // The same id again would return the rejected attempt's result: a fresh id for a real retry.
      setReview(null);
    } finally {
      setBusy(false);
    }
  };

  if (!p) return <Panel title="Trade"><Empty>Join a competition on the Leaderboard page to trade here.</Empty></Panel>;
  const valid = (by === 'amount' && type === 'market' ? amountCents > 0 : qtyMicro > 0) && (type === 'market' || limitUnits > 0);
  return (
    <Panel title={`Trade ${i.symbol}`} right={<span className="text-xs text-ink-3">{p.season.name}</span>}>
      <div className="grid gap-3 p-4">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-night p-1">
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={side === s} onClick={() => (setSide(s), setReview(null))}
              className={`rounded py-2 text-sm font-bold uppercase ${side === s ? (s === 'buy' ? 'bg-up text-night' : 'bg-down text-night') : 'text-ink-2'}`}>{s}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="flex flex-col gap-1 text-xs text-ink-3">Order type
            <select value={type} onChange={(e) => (setType(e.target.value as 'market' | 'limit'), setReview(null))} className="rounded-md border border-rule bg-night px-2 py-2 text-sm text-ink">
              <option value="market">Market</option><option value="limit">Limit</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">{type === 'market' && side === 'buy' ? 'Buy by' : 'Quantity in'}
            <select value={type === 'market' && side === 'buy' ? by : 'shares'} disabled={!(type === 'market' && side === 'buy')} onChange={(e) => (setBy(e.target.value as 'shares' | 'amount'), setReview(null))} className="rounded-md border border-rule bg-night px-2 py-2 text-sm text-ink">
              <option value="shares">Shares</option><option value="amount">Euro amount</option>
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-3">{by === 'amount' && type === 'market' && side === 'buy' ? 'Amount (EUR)' : 'Shares (fractions allowed)'}
          <input inputMode="decimal" value={qtyText} onChange={(e) => (setQty(e.target.value), setReview(null))} className="rounded-md border border-rule bg-night px-3 py-2 text-base tabular-nums text-ink" />
        </label>
        {side === 'sell' && pos && <button type="button" className="-mt-2 self-start text-xs text-saffron" onClick={() => (setQty(String((pos.qty - pos.reservedQty) / 1_000_000)), setBy('shares'))}>Sell all ({shares(pos.qty - pos.reservedQty)})</button>}
        {type === 'limit' && (
          <label className="flex flex-col gap-1 text-xs text-ink-3">Limit price ({minor ? 'pence' : i.currency})
            <input inputMode="decimal" value={limitText} placeholder={q?.last ? String(q.last / 10_000) : ''} onChange={(e) => (setLimit(e.target.value), setReview(null))} className="rounded-md border border-rule bg-night px-3 py-2 text-base tabular-nums text-ink" />
          </label>
        )}
        {type === 'limit' && !open && !extended && (
          <label className="flex items-start gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} className="mt-0.5" />
            The market is closed. Queue this order for the next session ({ex ? new Date(ex.nextOpen).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}). It may fill at a very different price after an overnight gap.
          </label>
        )}
        <dl className="grid gap-1 rounded-md bg-night px-3 py-2 text-sm">
          <div className="flex justify-between"><dt className="text-ink-3">{side === 'buy' ? 'Ask' : 'Bid'}</dt><dd className="tabular-nums">{price(side === 'buy' ? q?.ask : q?.bid, i.currency)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-3">Estimated {side === 'buy' ? 'cost' : 'proceeds'}</dt><dd className="tabular-nums font-bold">{estimate === null ? '—' : money(estimate)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-3">Available cash</dt><dd className="tabular-nums">{money(p.cash - p.reserved)}</dd></div>
          {pos && <div className="flex justify-between"><dt className="text-ink-3">You hold</dt><dd className="tabular-nums">{shares(pos.qty)}{pos.reservedQty ? ` (${shares(pos.reservedQty)} in orders)` : ''}</dd></div>}
          {i.currency !== 'EUR' && fx && <div className="flex justify-between text-xs"><dt className="text-ink-3">Rate</dt><dd className="tabular-nums text-ink-3">{fx} {minor ? 'GBP' : i.currency} per EUR</dd></div>}
        </dl>
        {!tradableNow && <p className="text-sm text-saffron">{type === 'market' ? `${ex?.name ?? 'This exchange'} is ${(ex && STATE_LABEL[ex.state]?.toLowerCase()) ?? 'closed'}. Market orders fill only in the regular session.` : 'Tick the box above to queue the order, or wait for the session.'}</p>}
        {err && <p role="alert" className="text-sm text-down">{err}</p>}
        {!review ? (
          <button type="button" disabled={!valid || !tradableNow} onClick={() => (setErr(null), setReview(uuid()))}
            className={`rounded-md py-3 font-bold text-night disabled:opacity-40 ${side === 'buy' ? 'bg-up' : 'bg-down'}`}>Review order</button>
        ) : (
          <div className="grid gap-2 rounded-md border border-saffron/60 p-3">
            <p className="text-sm">
              {side === 'buy' ? 'Buy' : 'Sell'} {by === 'amount' && type === 'market' && side === 'buy' ? `${money(amountCents)} of` : shares(qtyMicro)} {i.symbol} {type === 'market' ? 'at market' : `with a limit of ${price(limitUnits, i.currency)}`}
              {estimate !== null && <>, about {money(estimate)}</>}. The fill price comes from the live quote at execution.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setReview(null)} className="rounded-md border border-rule py-2 text-sm">Back</button>
              <button type="button" disabled={busy} onClick={() => void submit()} className="rounded-md bg-saffron py-2 text-sm font-bold text-night disabled:opacity-50">{busy ? 'Sending' : 'Confirm'}</button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** The euro rate for display only; fills always use the server's rate. */
function useFx(currency: string) {
  const [rate, setRate] = useState<number | null>(currency === 'EUR' ? 1 : null);
  useEffect(() => {
    if (currency === 'EUR') return;
    api<{ rate: string | null }>(`/fx/${encodeURIComponent(currency)}`).then((r) => setRate(r.rate ? Number(r.rate) : null), () => setRate(null));
  }, [currency]);
  return rate;
}

// ---------------------------------------------------------------- portfolio

export function PortfolioPage() {
  const [season, setSeason] = useSeason();
  const version = useLive((s) => s.version);
  const { data } = useLoad<{ portfolio: Portfolio | null }>(`/portfolio?season=${season}`, [version]);
  const hist = useLoad<{ points: [number, number][] }>(`/history?season=${season}`, [version]).data;
  const seasons = useLoad<{ seasons: Season[] }>('/seasons').data?.seasons.filter((s) => s.joined) ?? [];
  usePositionQuotes(data?.portfolio ?? null);
  const quotes = useLive((s) => s.quotes);
  const p = data?.portfolio;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-display text-2xl font-black uppercase">Portfolio</h1>
        <select aria-label="Competition" value={season} onChange={(e) => setSeason(e.target.value)} className="ml-auto rounded-md border border-rule bg-night-2 px-2 py-1.5 text-sm">
          {seasons.map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
          {!seasons.some((s) => s.slug === season) && <option value={season}>{season}</option>}
        </select>
      </div>
      {!p ? <Panel><Empty>You have not joined this competition.</Empty></Panel> : (
        <>
          <Panel><Summary p={p} /></Panel>
          {hist && hist.points.length > 1 && <Panel title="Value over time"><Spark points={hist.points} start={p.season.startingCash} /></Panel>}
          <Panel title="Positions">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-left text-xs text-ink-3">
                  <tr>{['Instrument', 'Shares', 'Avg cost', 'Price', 'Value', 'Today', 'Unrealised', 'Realised'].map((h) => <th key={h} className="px-4 py-2 text-right font-semibold first:text-left">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {p.positions.map((x) => {
                    const q = quotes.get(x.instrument.id);
                    return (
                      <tr key={x.instrument.id} className="border-t border-rule/60">
                        <td className="px-4 py-2"><Link to={`/stock/${x.instrument.id}`} className="font-bold">{x.instrument.symbol}</Link><span className="block max-w-56 truncate text-xs text-ink-3">{x.instrument.name}</span></td>
                        <td className="px-4 text-right tabular-nums">{shares(x.qty)}</td>
                        <td className="px-4 text-right tabular-nums">{money(Math.round((x.cost * 1_000_000) / x.qty))}</td>
                        <td className="px-4 text-right"><Px v={q?.last ?? x.mark} currency={x.instrument.currency} /><span className="block"><Quality q={q} i={x.instrument} /></span></td>
                        <td className="px-4 text-right tabular-nums">{x.value === null ? <span className="text-ink-3">at cost</span> : money(x.value)}</td>
                        <td className="px-4 text-right">{x.dayChange === null ? '—' : <Pnl cents={x.dayChange} />}</td>
                        <td className="px-4 text-right">{x.unrealized === null ? '—' : <Pnl cents={x.unrealized} />}</td>
                        <td className="px-4 text-right">{x.realized ? <Pnl cents={x.realized} /> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!p.positions.length && <Empty>No positions yet. Find a stock and buy it.</Empty>}
            </div>
            <p className="border-t border-rule px-4 py-2 text-xs text-ink-3">Values refresh on every fill; prices on this page move live. Realised P&L {signedMoney(p.realized)}.</p>
          </Panel>
        </>
      )}
    </div>
  );
}

function Spark({ points, start }: { points: [number, number][]; start: number }) {
  const w = 800, h = 140;
  const xs = points.map((p) => p[0]), ys = [...points.map((p) => p[1]), start];
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const X = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * w;
  const Y = (y: number) => h - ((y - y0) / Math.max(1, y1 - y0)) * (h - 10) - 5;
  const last = points.at(-1)![1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-36 w-full" preserveAspectRatio="none" role="img" aria-label={`Value from ${money(points[0]![1])} to ${money(last)}`}>
      <line x1={0} x2={w} y1={Y(start)} y2={Y(start)} stroke="var(--color-rule)" strokeDasharray="4 4" />
      <polyline fill="none" stroke={last >= start ? 'var(--color-up)' : 'var(--color-down)'} strokeWidth={2} vectorEffect="non-scaling-stroke" points={points.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ')} />
    </svg>
  );
}

// ---------------------------------------------------------------- orders and history

const ORDER_TONE: Record<string, string> = { filled: 'text-up', cancelled: 'text-ink-3', rejected: 'text-down', open: 'text-saffron', partially_filled: 'text-saffron' };

export function Orders() {
  const [season] = useSeason();
  const version = useLive((s) => s.version);
  const { data, reload } = useLoad<{ orders: Order[] }>(`/orders?season=${season}`, [version]);
  const cancel = async (id: string) => {
    await api(`/orders/${id}`, { method: 'DELETE' }).catch((e: Error) => toast(e.message, 'down'));
    reload();
  };
  const working = data?.orders.filter((o) => o.status === 'open' || o.status === 'partially_filled') ?? [];
  const done = data?.orders.filter((o) => !working.includes(o)) ?? [];
  const row = (o: Order) => (
    <tr key={o.id} className="border-t border-rule/60">
      <td className="px-4 py-2"><Link to={`/stock/${o.instrument.id}`} className="font-bold">{o.instrument.symbol}</Link></td>
      <td className={`px-4 font-semibold uppercase ${o.side === 'buy' ? 'text-up' : 'text-down'}`}>{o.side}</td>
      <td className="px-4">{o.type}{o.queued ? ' · queued' : ''}</td>
      <td className="px-4 text-right tabular-nums">{shares(o.filledQty)} / {shares(o.qty)}</td>
      <td className="px-4 text-right tabular-nums">{o.limitPrice ? price(o.limitPrice, o.instrument.currency) : 'market'}</td>
      <td className={`px-4 ${ORDER_TONE[o.status]}`}>{o.status.replace('_', ' ')}{o.reason && <span className="block text-xs text-ink-3">{o.reason}</span>}</td>
      <td className="px-4 text-xs text-ink-3">{new Date(o.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td className="px-4 text-right">{(o.status === 'open' || o.status === 'partially_filled') && <button type="button" onClick={() => void cancel(o.id)} className="rounded border border-rule px-2 py-1 text-xs hover:border-down hover:text-down">Cancel</button>}</td>
    </tr>
  );
  const table = (list: Order[], empty: string) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm"><tbody>{list.map(row)}</tbody></table>
      {!list.length && <Empty>{empty}</Empty>}
    </div>
  );
  return (
    <div className="grid gap-4">
      <Panel title="Working orders">{table(working, 'No working orders.')}</Panel>
      <Panel title="Order history">{table(done, 'No orders yet.')}</Panel>
    </div>
  );
}

export function HistoryPage() {
  const [season] = useSeason();
  const version = useLive((s) => s.version);
  const { data } = useLoad<{ executions: Execution[]; ledger: LedgerEntry[] }>(`/executions?season=${season}`, [version]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Executions">
        <ul>
          {data?.executions.map((e) => (
            <li key={e.id} className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-rule/60 px-4 py-2 text-sm">
              <span><span className={`font-semibold uppercase ${e.side === 'buy' ? 'text-up' : 'text-down'}`}>{e.side}</span> {shares(e.qty)} <Link to={`/stock/${e.instrument.id}`} className="font-bold">{e.instrument.symbol}</Link> at {price(e.price, e.instrument.currency)}</span>
              <span className="text-right tabular-nums">{money(e.total)}</span>
              <span className="text-xs text-ink-3">{new Date(e.at).toLocaleString()} · {e.basis} · quote {new Date(e.quoteAt).toLocaleTimeString()} ({e.quality}) · {e.fxPerEur} per EUR</span>
              <span className="text-right text-xs">{e.realized ? <Pnl cents={e.realized} /> : null}</span>
            </li>
          ))}
        </ul>
        {data && !data.executions.length && <Empty>No trades yet.</Empty>}
      </Panel>
      <Panel title="Cash ledger">
        <ul>
          {data?.ledger.map((l) => (
            <li key={l.id} className="flex justify-between gap-3 border-b border-rule/60 px-4 py-2 text-sm">
              <span>{l.note ?? l.kind}<span className="block text-xs text-ink-3">{new Date(l.at).toLocaleString()}</span></span>
              <span className="text-right tabular-nums"><span className={tone(l.amount)}>{signedMoney(l.amount)}</span><span className="block text-xs text-ink-3">{money(l.balanceAfter)}</span></span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- competition

const SORTS: [string, string][] = [['value', 'Portfolio value'], ['return', 'Return'], ['day', 'Today'], ['pick', 'Best pick']];

export function Leaderboard({ signedIn }: { signedIn: boolean }) {
  const [season, setSeason] = useSeason();
  const [sort, setSort] = useState('value');
  const { data: seasons, reload: reloadSeasons } = useLoad<{ seasons: Season[] }>('/seasons');
  const { data, reload } = useLoad<{ rows: (BoardRow & { following: boolean })[]; you: string | null }>(`/leaderboard?season=${season}&sort=${sort}`);
  const now = useClock(30_000);
  const current = seasons?.seasons.find((s) => s.slug === season);
  const join = async (s: Season) => {
    try {
      await api(`/seasons/${s.id}/join`, { method: 'POST', json: {} });
      setSeason(s.slug);
      reloadSeasons();
      reload();
    } catch (e) {
      toast((e as Error).message, 'down');
    }
  };
  const follow = async (id: string, on: boolean) => {
    await api(`/follow/${id}`, { method: on ? 'PUT' : 'DELETE' }).catch(() => {});
    reload();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Panel title={current?.name ?? 'Leaderboard'} right={
        <div className="flex gap-1">{SORTS.map(([k, l]) => <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)} className={`rounded px-2 py-1 text-xs font-semibold ${sort === k ? 'bg-saffron text-night' : 'text-ink-2 hover:bg-night-3'}`}>{l}</button>)}</div>
      }>
        <ol>
          {data?.rows.map((r) => (
            <li key={r.userId} className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-rule/60 px-4 py-2 text-sm ${r.userId === data.you ? 'bg-saffron-deep/40' : ''}`}>
              <span className="font-display text-lg font-black text-ink-3">{r.rank}</span>
              <Link to={`/player/${r.userId}`} className="flex min-w-0 items-center gap-2">
                <Lattice nickname={r.nickname} size={22} you={r.userId === data.you} />
                <span className="truncate font-semibold">{r.nickname}</span>
                {r.bestPick && <span className="hidden text-xs text-ink-3 sm:inline">best {r.bestPick.symbol} {pct(r.bestPick.returnBps)}</span>}
              </Link>
              <span className="text-right tabular-nums">
                {sort === 'day' ? (r.dayPnl === null ? '—' : <Pnl cents={r.dayPnl} />) : sort === 'pick' ? (r.bestPick ? `${r.bestPick.symbol} ${pct(r.bestPick.returnBps)}` : '—') : money(r.value)}
                <span className="block text-xs"><Change bps={r.returnBps} /></span>
              </span>
              {signedIn && r.userId !== data.you ? (
                <button type="button" onClick={() => void follow(r.userId, !r.following)} className={`rounded border px-2 py-1 text-xs ${r.following ? 'border-saffron text-saffron' : 'border-rule text-ink-2'}`}>{r.following ? 'Following' : 'Follow'}</button>
              ) : <span />}
            </li>
          ))}
        </ol>
        {data && !data.rows.length && <Empty>No players yet.</Empty>}
      </Panel>
      <div className="grid content-start gap-4">
        <Panel title="Competitions">
          <ul>
            {seasons?.seasons.map((s) => {
              const canJoin = !s.joined && s.status !== 'finished' && (!s.joinUntil || s.joinUntil > now) && (!s.endsAt || s.endsAt > now);
              return (
                <li key={s.id} className={`border-b border-rule/60 px-4 py-3 text-sm ${s.slug === season ? 'bg-night-3' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => setSeason(s.slug)} className="text-left font-semibold hover:text-saffron">{s.name}</button>
                    <span className="text-xs uppercase text-ink-3">{s.status}</span>
                  </div>
                  <p className="text-xs text-ink-3">
                    {money(s.startingCash)} start · {s.players} player{s.players === 1 ? '' : 's'}
                    {s.endsAt && ` · ${s.status === 'finished' ? 'ended' : 'ends'} ${new Date(s.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                  </p>
                  <p className="mt-1 text-xs text-ink-2">{s.rules}</p>
                  {signedIn && canJoin && <button type="button" onClick={() => void join(s)} className="mt-2 rounded-md bg-saffron px-3 py-1.5 text-xs font-bold text-night">Join</button>}
                  {s.joined && <span className="mt-1 block text-xs text-up">Joined</span>}
                  {!s.joined && !canJoin && s.status !== 'finished' && <span className="mt-1 block text-xs text-ink-3">Registration closed</span>}
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

export function Player({ id }: { id: string }) {
  const [season] = useSeason();
  const { data, reload } = useLoad<{
    nickname: string; public: boolean; followers: number; following: boolean; summary: { value: number; returnBps: number; dayPnl: number | null; startingCash: number } | null;
    positions: Portfolio['positions'] | null; trades: Execution[] | null; history: [number, number][];
  }>(`/players/${id}?season=${season}`);
  if (!data) return <Empty>Loading</Empty>;
  return (
    <div className="grid gap-4">
      <Panel>
        <div className="flex flex-wrap items-center gap-4 p-4">
          <Lattice nickname={data.nickname} size={48} />
          <div>
            <h1 className="font-display text-2xl font-black uppercase">{data.nickname}</h1>
            <p className="text-xs text-ink-3">{data.followers} follower{data.followers === 1 ? '' : 's'} · {data.public ? 'public portfolio' : 'private portfolio'}</p>
          </div>
          {data.summary && <div className="ml-auto text-right"><p className="text-xl font-bold">{money(data.summary.value)}</p><Change bps={data.summary.returnBps} /></div>}
          <button type="button" onClick={() => void api(`/follow/${id}`, { method: data.following ? 'DELETE' : 'PUT' }).then(reload, () => {})} className="rounded border border-rule px-3 py-1.5 text-sm">{data.following ? 'Unfollow' : 'Follow'}</button>
        </div>
      </Panel>
      {data.history.length > 1 && data.summary && <Panel title="Value over time"><Spark points={data.history} start={data.summary.startingCash} /></Panel>}
      {data.positions === null ? <Panel><Empty>{data.nickname} keeps their holdings private.</Empty></Panel> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Holdings">
            <ul>{data.positions.map((x) => (
              <li key={x.instrument.id} className="flex justify-between border-b border-rule/60 px-4 py-2 text-sm">
                <Link to={`/stock/${x.instrument.id}`} className="font-bold">{x.instrument.symbol}</Link>
                <span className="tabular-nums">{shares(x.qty)} · {x.value === null ? 'at cost' : money(x.value)} {x.unrealized !== null && <Pnl cents={x.unrealized} />}</span>
              </li>
            ))}</ul>
            {!data.positions.length && <Empty>No holdings.</Empty>}
          </Panel>
          <Panel title="Recent trades">
            <ul>{data.trades?.map((e) => (
              <li key={e.id} className="flex justify-between border-b border-rule/60 px-4 py-2 text-sm">
                <span><span className={e.side === 'buy' ? 'text-up' : 'text-down'}>{e.side}</span> {shares(e.qty)} {e.instrument.symbol}</span>
                <span className="text-xs text-ink-3">{new Date(e.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
              </li>
            ))}</ul>
          </Panel>
        </div>
      )}
    </div>
  );
}

const MUTABLE: [string, string][] = [['fill', 'Limit order fills'], ['move', 'Big moves in stocks I watch or hold'], ['session', 'Market opens and closes'], ['rank', 'Leaderboard rank changes'], ['season', 'Competition results']];

export function Settings() {
  const { data, reload } = useLoad<{ public: boolean; muted: string[] }>('/profile');
  if (!data) return <Empty>Loading</Empty>;
  const save = (pub: boolean, muted: string[]) => void api('/profile', { method: 'PUT', json: { public: pub, muted } }).then(reload);
  return (
    <div className="grid max-w-xl gap-4">
      <Panel title="Privacy">
        <label className="flex items-start gap-3 p-4 text-sm">
          <input type="checkbox" checked={data.public} onChange={(e) => save(e.target.checked, data.muted)} className="mt-1" />
          <span>Public portfolio<span className="block text-xs text-ink-3">Others can see your holdings and trades, and your fills appear in player activity. Your value and rank are on the leaderboard either way.</span></span>
        </label>
      </Panel>
      <Panel title="Notifications">
        <div className="grid gap-2 p-4">
          {MUTABLE.map(([k, l]) => (
            <label key={k} className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={!data.muted.includes(k)} onChange={(e) => save(data.public, e.target.checked ? data.muted.filter((m) => m !== k) : [...data.muted, k])} />
              {l}
            </label>
          ))}
        </div>
      </Panel>
      <ExecutionPolicy />
    </div>
  );
}
