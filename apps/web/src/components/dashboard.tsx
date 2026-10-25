import { ArrowDown, ArrowUp, Search, SlidersHorizontal } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { indexLevel } from '../../../server/src/market/dashboard';
import { eps, money, ordinal, pct, points, ratio, SECTOR_COLOR, tone, when } from '../lib/format';
import { marketStats, summarize, usePoll, type MarketStats } from '../lib/dashboard';
import { roomQuery, useGame, type EventInfo } from '../lib/game';
import { usePortfolio } from '../lib/portfolio';
import { peText, useResearch, type Metrics } from '../lib/research';
import { marginOf, NO_FILTERS, screen, sortRows, type Column, type Filters, type ScreenRow } from '../lib/screener';
import type { Activity, Reaction } from '../../../server/src/protocol';
import { PriceChart, TimelineChart, type ChartSubject } from './chart';
import { FavStar } from './floor';
import { Change, Pnl, useKept, useMedia, useNow, useStale } from './chrome';

type Pick = (ticker: string) => void;

// ---------------------------------------------------------------- shared pieces

function Title({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
      <h2 className="panel-title">{children}</h2>
      {note && <span className="text-right text-[12px] text-ink-3">{note}</span>}
    </div>
  );
}

function Swatch({ sector }: { sector: string }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SECTOR_COLOR[sector] }} aria-hidden />;
}

/** A row that opens a company: ticker and name, then whatever figures the list is about. */
function CompanyRow({ m, onSelect, children }: { m: Metrics; onSelect: Pick; children: React.ReactNode }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(m.asset.ticker)} className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-1.5 text-left hover:bg-night-3">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <Swatch sector={m.asset.sector} />
            <span className="text-[14px] font-bold">{m.asset.ticker}</span>
          </span>
          <span className="block truncate text-[12px] text-ink-3">{m.asset.name}</span>
        </span>
        <span className="text-right">{children}</span>
      </button>
    </li>
  );
}

/** The market's state in words: open or not, how fresh the prices are, and whether they are live. */
function MarketStatus() {
  const session = useGame((s) => s.session);
  const conn = useGame((s) => s.conn);
  const at = useGame((s) => s.at);
  const offset = useGame((s) => s.offset);
  const stale = useStale();
  const t = useNow(offset, 1000);
  const open = session?.phase === 'trading' || session?.phase === 'closing';
  const state = conn !== 'open' ? 'Reconnecting' : stale ? 'Prices delayed' : open ? 'Live' : session?.phase === 'lobby' ? 'Before the bell' : 'Market closed';
  const live = state === 'Live';
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3" role="status">
      <span className={`inline-flex items-center gap-1.5 font-semibold uppercase tracking-[0.08em] ${live ? 'text-up' : state === 'Reconnecting' || state === 'Prices delayed' ? 'text-saffron' : 'text-ink-2'}`}>
        <span className={`h-2 w-2 rounded-full ${live ? 'animate-pulse bg-up motion-reduce:animate-none' : state === 'Reconnecting' || state === 'Prices delayed' ? 'bg-saffron' : 'bg-ink-3'}`} aria-hidden />
        {state}
      </span>
      {at > 0 && <span>Last price {when(at, t)}</span>}
      {session?.phase === 'lobby' && <span>· opens in {Math.max(0, Math.ceil((session.opensAt - t) / 1000))}s</span>}
    </p>
  );
}

// ---------------------------------------------------------------- the market chart

type ChartPick = { kind: 'market' } | { kind: 'sector'; sector: string } | { kind: 'company'; ticker: string };

/** An equal-weighted index of the whole listing or one sector, folded live from every tick. */
function useIndexSubject(sector: string | null): ChartSubject {
  const index = useGame((s) => s.index);
  const open = useGame((s) => s.open);
  return useMemo(() => {
    const level = (prices: number[], base: Record<string, number> | undefined) =>
      base ? indexLevel(Object.keys(base).map((t) => ({ price: prices[index.get(t) ?? -1], base: base[t] }))) ?? undefined : undefined;
    return {
      key: `index:${sector ?? 'market'}`,
      label: sector ? `${sector} index, equal-weighted, simulated` : 'Haggle market index, equal-weighted, simulated',
      url: (range) => `/api/index?range=${range}${sector ? `&sector=${encodeURIComponent(sector)}` : ''}`,
      value: (p, s) => level(p, s.base),
      baseline: (s) => (s ? level(open, s.base) : undefined),
      format: points,
      concerns: (ev: EventInfo) => (sector ? ev.target === sector || ev.category === 'macro' : ev.category === 'macro' || ev.severity === 3),
    };
  }, [sector, index, open]);
}

function MarketChart({ pick, setPick, onSelect }: { pick: ChartPick; setPick: (p: ChartPick) => void; onSelect: Pick }) {
  const assets = useGame((s) => s.assets);
  const sectors = useMemo(() => [...new Set(assets.map((a) => a.sector))], [assets]);
  const indexSubject = useIndexSubject(pick.kind === 'sector' ? pick.sector : null);
  const ticker = pick.kind === 'company' ? pick.ticker : null;
  const id = useId();
  const kinds = [
    { id: 'market', label: 'Market' },
    { id: 'sector', label: 'Sector' },
    { id: 'company', label: 'Company' },
  ] as const;
  const choose = (kind: ChartPick['kind']) =>
    setPick(kind === 'market' ? { kind } : kind === 'sector' ? { kind, sector: pick.kind === 'sector' ? pick.sector : sectors[0] ?? '' } : { kind, ticker: ticker ?? assets[0]?.ticker ?? '' });

  return (
    <section aria-label="Market chart" className="flex flex-col border-b border-rule">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
        <h2 className="panel-title mr-auto">{pick.kind === 'market' ? 'Haggle index' : pick.kind === 'sector' ? `${pick.sector} index` : `${ticker} price`}</h2>
        <div role="radiogroup" aria-label="Chart shows" className="flex rounded-md bg-night p-0.5">
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={pick.kind === k.id}
              onClick={() => choose(k.id)}
              className={`h-8 rounded-[5px] px-3 text-[12px] font-semibold ${pick.kind === k.id ? 'bg-night-4 text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        {pick.kind === 'sector' && (
          <label>
            <span className="sr-only">Sector</span>
            <select value={pick.sector} onChange={(e) => setPick({ kind: 'sector', sector: e.target.value })} className="h-9 rounded-md border border-rule bg-night px-2 text-[13px] text-ink focus:border-saffron/60 focus:outline-none">
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        {pick.kind === 'company' && (
          <>
            <label htmlFor={`${id}-co`} className="sr-only">Company</label>
            <select id={`${id}-co`} value={ticker ?? ''} onChange={(e) => setPick({ kind: 'company', ticker: e.target.value })} className="h-9 max-w-[12rem] rounded-md border border-rule bg-night px-2 text-[13px] text-ink focus:border-saffron/60 focus:outline-none">
              {assets.map((a) => <option key={a.ticker} value={a.ticker}>{a.ticker} · {a.name}</option>)}
            </select>
            {ticker && (
              <button type="button" onClick={() => onSelect(ticker)} className="h-9 rounded-md bg-saffron px-3 text-[13px] font-bold text-night hover:brightness-110">
                Research and trade
              </button>
            )}
          </>
        )}
      </div>
      <div className="h-[280px] sm:h-[340px]">
        {ticker ? <PriceChart key={ticker} ticker={ticker} wheel={false} /> : <TimelineChart key={indexSubject.key} subject={indexSubject} wheel={false} />}
      </div>
      <p className="px-4 pb-2 pt-1 text-[11px] text-ink-3">
        {pick.kind === 'company'
          ? 'Simulated price in euro. Dots mark news about the company, its sector or the economy; squares mark opening bells.'
          : 'Equal-weighted index of simulated prices, 1,000 points at each company\'s first recorded price. Dots mark news; squares mark opening bells.'}
        {' '}Drag to pan; drag the axes or pinch to zoom.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- overview

function Headline({ s }: { s: MarketStats }) {
  const regime = useGame((g) => g.regime);
  const total = s.up + s.down + s.flat;
  return (
    <section aria-label="Market summary" className="grid border-b border-rule md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="flex flex-col gap-2 px-4 py-4 md:border-r md:border-rule">
        <MarketStatus />
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-display text-[40px] font-black uppercase leading-[0.9]">Market</span>
          <Change bps={s.bps} className="text-[22px] font-semibold" />
          <span className="text-[12px] text-ink-3">equal-weighted, since the bell</span>
        </div>
        {total > 0 && (
          <div>
            <div className="flex h-2 overflow-hidden rounded-full bg-night-4" role="img" aria-label={`${s.up} rising, ${s.flat} unchanged, ${s.down} falling`}>
              <span className="bg-up" style={{ width: `${(s.up / total) * 100}%` }} />
              <span className="bg-ink-3" style={{ width: `${(s.flat / total) * 100}%` }} />
              <span className="bg-down" style={{ width: `${(s.down / total) * 100}%` }} />
            </div>
            <p className="mt-1 flex justify-between text-[12px]">
              <span className="text-up">↗ {s.up} rising</span>
              {s.flat > 0 && <span className="text-ink-3">{s.flat} unchanged</span>}
              <span className="text-down">↘ {s.down} falling</span>
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col justify-center gap-1.5 border-t border-rule px-4 py-4 md:border-t-0">
        <h2 className="panel-title">Session summary</h2>
        <p className="max-w-[70ch] text-[14px] leading-relaxed text-ink">{summarize(s, regime)}</p>
        <p className="text-[11px] text-ink-3">Written from the live simulated prices. Not a forecast and not financial advice.</p>
      </div>
    </section>
  );
}

function Movers({ s, onSelect }: { s: MarketStats; onSelect: Pick }) {
  const research = useResearch();
  const session = useGame((g) => g.session?.id);
  const { data, failed } = usePoll<Activity>(`/api/activity${roomQuery}`, 10_000, session);
  const active = (data && data.sessionId === session ? data.rows : []).slice(0, 5);
  const list = (title: string, rows: Metrics[], empty: string) => (
    <section aria-label={title} className="flex min-w-0 flex-col border-b border-rule lg:border-b-0 lg:border-r lg:last:border-r-0">
      <Title>{title}</Title>
      {rows.length ? (
        <ol className="pb-2">
          {rows.map((m) => (
            <CompanyRow key={m.asset.ticker} m={m} onSelect={onSelect}>
              <span className="block text-[14px] font-medium">{money(m.price)}</span>
              <Change bps={m.bps} className="text-[12px]" />
            </CompanyRow>
          ))}
        </ol>
      ) : (
        <p className="px-4 pb-4 text-[13px] text-ink-3">{empty}</p>
      )}
    </section>
  );
  return (
    <div className="grid border-b border-rule lg:grid-cols-3">
      {list('Top gainers', s.gainers, 'Nothing is up since the bell.')}
      {list('Top losers', s.losers, 'Nothing is down since the bell.')}
      <section aria-label="Most traded" className="flex min-w-0 flex-col">
        <Title note="this competition">Most traded</Title>
        {!data && !failed ? (
          <p className="px-4 pb-4 text-[13px] text-ink-3">Loading trading activity</p>
        ) : !data && failed ? (
          <p className="px-4 pb-4 text-[13px] text-ink-3">Trading activity did not load. It retries every few seconds.</p>
        ) : active.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-ink-3">No trades yet in this competition.</p>
        ) : (
          <ol className="pb-2">
            {active.flatMap((a) => {
              const m = research.byTicker.get(a.ticker);
              return m ? [
                <CompanyRow key={a.ticker} m={m} onSelect={onSelect}>
                  <span className="block text-[14px] font-medium">{a.trades} {a.trades === 1 ? 'trade' : 'trades'}</span>
                  <span className="block text-[12px] text-ink-3">{a.shares.toLocaleString('en-IE')} shares · {money(a.turnover)}</span>
                </CompanyRow>,
              ] : [];
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function Sectors({ s, onSector }: { s: MarketStats; onSector: (sector: string) => void }) {
  const spread = Math.max(1, ...s.sectors.map((x) => Math.abs(x.bps)));
  return (
    <section aria-label="Sector performance" className="border-b border-rule">
      <Title note="equal-weighted, since the bell">Sector performance</Title>
      <ul className="grid pb-2 xl:grid-cols-2 xl:gap-x-2">
        {s.sectors.map((x) => (
          <li key={x.name} style={{ ['--stripe' as string]: SECTOR_COLOR[x.name] }}>
            <button type="button" onClick={() => onSector(x.name)} className="grid min-h-11 w-full grid-cols-[1.25rem_minmax(0,1fr)_minmax(4rem,28%)_4.5rem] items-center gap-3 px-4 py-1.5 text-left hover:bg-night-3">
              <span className="awning h-4 w-5 rounded-[2px]" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-semibold">{x.name}</span>
                <span className="block truncate text-[12px] text-ink-3">
                  {x.n} companies · best {x.best.asset.ticker} <span className={tone(x.best.bps)}>{pct(x.best.bps)}</span>
                </span>
              </span>
              <span className="relative h-2 rounded-full bg-night-4" aria-hidden>
                <span className={`absolute top-0 h-2 rounded-full ${x.bps >= 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down'}`} style={{ width: `${(Math.abs(x.bps) / spread) * 50}%` }} />
              </span>
              <Change bps={x.bps} className="justify-end text-[13px] font-semibold" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SUBJECT_LABEL: Record<Reaction['subject'], string> = { market: 'Market', sector: 'Sector', company: '' };
const CATEGORY_LABEL: Record<EventInfo['category'], string> = { macro: 'Economy', sector: 'Sector', company: 'Company' };

/** News in order with what the tape did next: the observed move from the tick before each story. */
function Timeline({ onSelect }: { onSelect: Pick }) {
  const events = useGame((s) => s.events);
  const tickMs = useGame((s) => s.session?.tickMs ?? 1000);
  const latest = events[0]?.id ?? 0;
  const { data, failed } = usePoll<{ reactions: Reaction[] }>('/api/reactions', 5000, latest);
  const byId = useMemo(() => new Map((data?.reactions ?? []).map((r) => [r.id, r])), [data]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section aria-label="News and price reactions" className="border-b border-rule">
      <Title note="move measured from the tick before each story">News and the tape</Title>
      {events.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-ink-3">No news yet. Stories land for every trader at the same moment, and their price reaction appears here.</p>
      ) : (
        <ol className="relative pb-3 pl-4 before:absolute before:bottom-3 before:left-[1.4rem] before:top-1 before:w-px before:bg-rule">
          {events.slice(0, 15).map((ev) => {
            const r = byId.get(ev.id);
            const isOpen = open === ev.id;
            const secs = r ? Math.round((r.ticks * tickMs) / 1000) : 0;
            return (
              <li key={ev.id} className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pr-4">
                <span className={`relative z-10 mt-3.5 h-3 w-3 rounded-full border-2 border-night ${ev.severity === 3 ? 'bg-down' : ev.severity === 2 ? 'bg-saffron' : 'bg-ink-3'}`} aria-hidden />
                <div className="min-w-0 border-b border-rule/60 py-2">
                  <button type="button" onClick={() => setOpen(isOpen ? null : ev.id)} aria-expanded={isOpen} className="w-full text-left">
                    <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
                      <time dateTime={new Date(ev.at).toISOString()}>{when(ev.at)}</time>
                      <span className="font-semibold uppercase tracking-[0.06em] text-ink-2">{CATEGORY_LABEL[ev.category]}</span>
                      {ev.category === 'sector' && ev.target && <span>{ev.target}</span>}
                      <span className="sr-only">Severity {ev.severity} of 3</span>
                    </span>
                    <span className="mt-0.5 block text-[14px] font-semibold leading-snug hover:text-saffron">{ev.headline}</span>
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
                    {!r ? (
                      <span className="text-ink-3">{failed && !data ? 'Reaction did not load' : data ? 'No price record for this story' : 'Measuring the reaction'}</span>
                    ) : (
                      <>
                        {r.subject !== 'company' && (
                          <span className={`rounded-sm px-1.5 py-0.5 font-semibold ${r.bps > 0 ? 'bg-up-deep text-up' : r.bps < 0 ? 'bg-down-deep text-down' : 'bg-night-4 text-ink-2'}`}>
                            {SUBJECT_LABEL[r.subject]} {pct(r.bps)}
                          </span>
                        )}
                        {r.moves.map((m) => (
                          <button
                            key={m.ticker}
                            type="button"
                            onClick={() => onSelect(m.ticker)}
                            className={`rounded-sm px-1.5 py-0.5 font-semibold hover:brightness-125 ${m.bps > 0 ? 'bg-up-deep text-up' : m.bps < 0 ? 'bg-down-deep text-down' : 'bg-night-4 text-ink-2'}`}
                          >
                            {m.ticker} {pct(m.bps)}
                          </button>
                        ))}
                        <span className="text-ink-3">{r.settled ? `over ${secs}s after the story` : `${secs}s in, still developing`}</span>
                      </>
                    )}
                  </div>
                  {isOpen && (
                    <div className="mt-2 text-[13px] text-ink-2">
                      <p className="leading-relaxed">{ev.body}</p>
                      {ev.figures.length > 0 && (
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                          {ev.figures.map((f) => (
                            <div key={f.label} className="contents">
                              <dt className="text-ink-3">{f.label}</dt>
                              <dd className="text-ink">{f.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                        Haggle Wire, simulated news
                        {ev.related.map((t) => (
                          <button key={t} type="button" onClick={() => onSelect(t)} className="rounded-sm border border-rule px-1.5 py-0.5 font-semibold text-ink hover:border-saffron/60">
                            {t}
                          </button>
                        ))}
                      </p>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="px-4 pb-3 text-[11px] text-ink-3">Reactions are the observed move of simulated prices, which also drift with every other story. They are not the story&apos;s cause measured in isolation.</p>
    </section>
  );
}

function Watchlist({ onSelect }: { onSelect: Pick }) {
  const favourites = useGame((s) => s.favourites);
  const { byTicker } = useResearch();
  const p = usePortfolio();
  const rows = favourites.flatMap((t) => byTicker.get(t) ?? []);
  return (
    <section aria-label="Watchlist" className="border-b border-rule">
      <Title note="on this device">Watchlist</Title>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-ink-3">Star a company in the screener or on its page to watch it here.</p>
      ) : (
        <ul className="pb-2">
          {rows.map((m) => {
            const held = p.byTicker.get(m.asset.ticker)?.qty ?? 0;
            return (
              <CompanyRow key={m.asset.ticker} m={m} onSelect={onSelect}>
                <span className="block text-[14px] font-medium">{money(m.price)}</span>
                <span className="flex items-center justify-end gap-2 text-[12px]">
                  {held > 0 && <span className="rounded-sm bg-saffron-deep px-1 text-[11px] font-semibold text-saffron">{held} held</span>}
                  <Change bps={m.bps} />
                </span>
              </CompanyRow>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The player's own standing, so the overview answers "how am I doing" next to "how is the market". */
function Purse({ onHoldings, onRoster }: { onHoldings: () => void; onRoster: () => void }) {
  const p = usePortfolio();
  const board = useGame((s) => s.board);
  const fig = 'flex min-w-0 flex-col';
  const label = 'text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3';
  return (
    <section aria-label="Your purse" className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule bg-night-2 px-4 py-2.5">
      <div className={fig}>
        <span className={label}>Your purse</span>
        <span className="flex items-baseline gap-2">
          <span className="text-[17px] font-semibold">{money(p.value)}</span>
          <Pnl cents={p.pnl} className="text-[13px] font-semibold" />
          <Change bps={p.bps} className="text-[13px]" />
        </span>
      </div>
      <div className={fig}><span className={label}>Cash</span><span className="text-[14px] font-semibold">{money(p.cash)}</span></div>
      <div className={`${fig} max-sm:hidden`}><span className={label}>Unrealised</span><Pnl cents={p.unrealized} className="text-[14px] font-semibold" /></div>
      <div className={`${fig} max-sm:hidden`}><span className={label}>Realised</span><Pnl cents={p.realized} className="text-[14px] font-semibold" /></div>
      <div className="ml-auto flex gap-2">
        <button type="button" onClick={onHoldings} className="h-9 rounded-md border border-rule px-3 text-[13px] font-semibold text-ink-2 hover:border-ink-3 hover:text-ink">
          {p.holdings.length ? `${p.holdings.length} ${p.holdings.length === 1 ? 'holding' : 'holdings'}` : 'All cash'}
        </button>
        <button type="button" onClick={onRoster} className="h-9 rounded-md border border-rule px-3 text-[13px] font-semibold text-ink-2 hover:border-ink-3 hover:text-ink">
          {board.me ? `Rank ${ordinal(board.me.rank)} of ${board.count}` : 'Roster'}
        </button>
      </div>
    </section>
  );
}

/** The market at a glance: where it stands, what moved, which industries, and why. */
export function Overview({ onSelect, onSector, onHoldings, onRoster }: { onSelect: Pick; onSector: (sector: string) => void; onHoldings: () => void; onRoster: () => void }) {
  const { rows } = useResearch();
  const s = useMemo(() => marketStats(rows), [rows]);
  const [pick, setPick] = useKept<ChartPick>('overview.chart', { kind: 'market' });
  const wide = useMedia('(min-width: 1536px)');
  if (!rows.length) return <p className="px-4 py-8 text-sm text-ink-3" role="status">Loading the market</p>;
  return (
    <div className="flex shrink-0 flex-col">
      <Purse onHoldings={onHoldings} onRoster={onRoster} />
      <Headline s={s} />
      <MarketChart pick={pick} setPick={setPick} onSelect={onSelect} />
      <Movers s={s} onSelect={onSelect} />
      {wide ? (
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="border-r border-rule">
            <Timeline onSelect={onSelect} />
          </div>
          <div>
            <Watchlist onSelect={onSelect} />
            <Sectors s={s} onSector={onSector} />
          </div>
        </div>
      ) : (
        <>
          <Sectors s={s} onSector={onSector} />
          <Timeline onSelect={onSelect} />
          <Watchlist onSelect={onSelect} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- screener

const COLUMNS: { id: Column; label: string; title?: string; className?: string }[] = [
  { id: 'ticker', label: 'Company' },
  { id: 'sector', label: 'Sector', className: 'hidden lg:table-cell' },
  { id: 'price', label: 'Price', title: 'Simulated price' },
  { id: 'change', label: 'Change', title: 'Since the opening bell' },
  { id: 'pe', label: 'P/E', title: 'Simulated price over trailing EPS' },
  { id: 'eps', label: 'EPS', title: 'Trailing twelve months, simulated' },
  { id: 'epsGrowth', label: 'EPS gr.', title: 'Trailing EPS, year on year', className: 'hidden 2xl:table-cell' },
  { id: 'revenueGrowth', label: 'Rev. gr.', title: 'Trailing revenue, year on year', className: 'hidden 2xl:table-cell' },
  { id: 'margin', label: 'Margin', title: 'Trailing net income over revenue', className: 'hidden min-[1800px]:table-cell' },
  { id: 'vsFair', label: 'vs fair', title: 'Price against the model fair value' },
  { id: 'trades', label: 'Trades', title: 'Executed in this competition', className: 'hidden lg:table-cell' },
];

const SORTS: { col: Column; desc: boolean; label: string }[] = [
  { col: 'change', desc: true, label: 'Top gainers' },
  { col: 'change', desc: false, label: 'Top losers' },
  { col: 'trades', desc: true, label: 'Most traded' },
  { col: 'pe', desc: false, label: 'Lowest P/E' },
  { col: 'vsFair', desc: false, label: 'Cheapest vs fair value' },
  { col: 'epsGrowth', desc: true, label: 'Fastest EPS growth' },
  { col: 'margin', desc: true, label: 'Highest margin' },
];

const vsFairText = (v: number | null) => (v === null ? 'N/A' : `${v >= 1 ? '+' : '−'}${Math.abs((v - 1) * 100).toFixed(0)}%`);

function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="h-9 rounded-md border border-rule bg-night px-2 text-[13px] text-ink focus:border-saffron/60 focus:outline-none">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/** Every listed company in one searchable, filterable, sortable table; a row opens the company. */
export function Screener({ onSelect }: { onSelect: Pick }) {
  const { rows } = useResearch();
  const session = useGame((s) => s.session?.id);
  const favourites = useGame((s) => s.favourites);
  const p = usePortfolio();
  const phone = useMedia('(max-width: 767px)');
  const { data } = usePoll<Activity>(`/api/activity${roomQuery}`, 10_000, session);
  const [f, setF] = useKept<Filters>('screener.filters', NO_FILTERS);
  const [sort, setSort] = useKept<{ col: Column; desc: boolean }>('screener.sort', { col: 'change', desc: true });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const set = <K extends keyof Filters>(k: K) => (v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));

  const trades = useMemo(() => new Map((data && data.sessionId === session ? data.rows : []).map((r) => [r.ticker, r.trades])), [data, session]);
  const all = useMemo<ScreenRow[]>(() => rows.map((r) => ({ ...r, trades: trades.get(r.asset.ticker) ?? 0, margin: marginOf(r) })), [rows, trades]);
  const sectors = useMemo(() => [...new Set(rows.map((r) => r.asset.sector))], [rows]);
  const held = useMemo(() => new Set(p.holdings.map((h) => h.asset.ticker)), [p.holdings]);
  const shown = useMemo(
    () => sortRows(screen(all, f, { favourites: new Set(favourites), held }), sort.col, sort.desc),
    [all, f, favourites, held, sort],
  );
  const active = Object.entries(f).filter(([k, v]) => v !== NO_FILTERS[k as keyof Filters]).length;
  const by = (col: Column) => setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: col !== 'ticker' && col !== 'sector' && col !== 'pe' && col !== 'vsFair' }));

  if (!rows.length) return <p className="px-4 py-8 text-sm text-ink-3" role="status">Loading the listing</p>;

  const filters = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <Select label="Sector" value={f.sector} onChange={set('sector')} options={[['', 'All sectors'], ...sectors.map((s) => [s, s] as [string, string])]} />
      <Select label="Movement" value={f.move} onChange={set('move')} options={[['all', 'Any'], ['up', 'Up since the bell'], ['down', 'Down since the bell']]} />
      <Select label="P/E" value={f.pe} onChange={set('pe')} options={[['all', 'Any'], ['lt15', 'Under 15'], ['15to30', '15 to 30'], ['gt30', 'Over 30'], ['none', 'No P/E (loss or too few quarters)']]} />
      <Select label="Profitability" value={f.profit} onChange={set('profit')} options={[['all', 'Any'], ['profitable', 'Profitable (trailing)'], ['loss', 'Loss-making (trailing)']]} />
      <Select label="Fair value" value={f.value} onChange={set('value')} options={[['all', 'Any'], ['below', 'Priced below'], ['above', 'Priced above']]} />
      <Select label="Show" value={f.show} onChange={set('show')} options={[['all', 'All companies'], ['favourites', 'Watchlist'], ['held', 'My holdings']]} />
    </div>
  );

  return (
    <section aria-label="Stock screener" className="flex shrink-0 flex-col">
      <div className="flex flex-col gap-3 border-b border-rule px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[12rem] flex-1">
            <span className="sr-only">Search companies</span>
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              type="search"
              value={f.q}
              onChange={(e) => set('q')(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && f.q && shown[0]) onSelect(shown[0].asset.ticker);
                if (e.key === 'Escape') set('q')('');
              }}
              placeholder={`Search ${rows.length} companies by name, ticker or industry`}
              className="h-10 w-full rounded-md border border-rule bg-night pl-9 pr-3 text-[16px] text-ink placeholder:text-ink-3 focus:border-saffron/60 focus:outline-none sm:text-sm"
            />
          </label>
          <label className="min-w-0">
            <span className="sr-only">Quick sort</span>
            <select
              value={SORTS.findIndex((s) => s.col === sort.col && s.desc === sort.desc)}
              onChange={(e) => {
                const s = SORTS[Number(e.target.value)];
                if (s) setSort({ col: s.col, desc: s.desc });
              }}
              className="h-10 rounded-md border border-rule bg-night px-2 text-[13px] text-ink focus:border-saffron/60 focus:outline-none"
            >
              <option value={-1} disabled>Custom sort</option>
              {SORTS.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
            </select>
          </label>
          {phone && (
            <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} className="flex h-10 items-center gap-1.5 rounded-md border border-rule px-3 text-[13px] font-semibold text-ink-2 hover:text-ink">
              <SlidersHorizontal size={15} aria-hidden /> Filters{active > (f.q ? 1 : 0) ? ` ${active - (f.q ? 1 : 0)}` : ''}
            </button>
          )}
        </div>
        {(!phone || filtersOpen) && filters}
        <p className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3" aria-live="polite">
          <span>{shown.length} of {rows.length} companies · simulated prices, simulated financials</span>
          {active > 0 && (
            <button type="button" onClick={() => setF(NO_FILTERS)} className="font-semibold text-saffron hover:underline">Clear filters</button>
          )}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-2">No company matches these filters.</p>
      ) : phone ? (
        <ul>
          {shown.map((r) => (
            <li key={r.asset.ticker} className="flex items-stretch border-b border-rule/60 [contain-intrinsic-size:auto_60px] [content-visibility:auto]">
              <FavStar ticker={r.asset.ticker} size={14} />
              <button type="button" onClick={() => onSelect(r.asset.ticker)} className="grid min-h-14 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2 pr-4 text-left active:bg-night-3">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <Swatch sector={r.asset.sector} />
                    <span className="text-[15px] font-bold">{r.asset.ticker}</span>
                    {held.has(r.asset.ticker) && <span className="rounded-sm bg-saffron-deep px-1 text-[11px] font-semibold text-saffron">held</span>}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">{r.asset.name}</span>
                  <span className="block text-[12px] text-ink-3">
                    P/E {peText(r.pe)} · EPS {r.asset.fund.epsTtm === null ? 'N/A' : eps(r.asset.fund.epsTtm)} · fair {vsFairText(r.vsFair)}
                    {r.trades ? ` · ${r.trades} trades` : ''}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-[15px] font-semibold">{money(r.price)}</span>
                  <Change bps={r.bps} className="text-[13px]" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] [&_td]:whitespace-nowrap">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3">
              <tr className="border-b border-rule">
                <th scope="col" className="w-9"><span className="sr-only">Watchlist</span></th>
                {COLUMNS.map((c) => {
                  const on = sort.col === c.id;
                  const Icon = sort.desc ? ArrowDown : ArrowUp;
                  return (
                    <th key={c.id} scope="col" aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'} className={`px-2 py-1 font-medium ${c.id === 'ticker' || c.id === 'sector' ? 'text-left' : 'text-right'} ${c.className ?? ''}`}>
                      <button type="button" onClick={() => by(c.id)} title={c.title} className={`inline-flex h-8 items-center gap-1 uppercase hover:text-ink ${on ? 'text-ink' : ''}`}>
                        {c.label}
                        {on && <Icon size={12} aria-hidden />}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const f2 = r.asset.fund;
                return (
                  <tr
                    key={r.asset.ticker}
                    className="border-b border-rule/60 hover:bg-night-3 [contain-intrinsic-size:auto_48px] [content-visibility:auto]"
                  >
                    <td><FavStar ticker={r.asset.ticker} size={14} /></td>
                    <th scope="row" className="px-2 py-1.5 text-left font-normal">
                      <button type="button" onClick={() => onSelect(r.asset.ticker)} className="flex min-w-0 items-center gap-2 text-left hover:text-saffron">
                        <Swatch sector={r.asset.sector} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-[14px] font-bold">
                            {r.asset.ticker}
                            {held.has(r.asset.ticker) && <span className="rounded-sm bg-saffron-deep px-1 text-[11px] font-semibold text-saffron">held</span>}
                          </span>
                          <span className="block max-w-[14rem] truncate text-[12px] text-ink-3">{r.asset.name}</span>
                        </span>
                      </button>
                    </th>
                    <td className="hidden px-2 text-ink-2 lg:table-cell whitespace-normal!">{r.asset.sector}</td>
                    <td className="px-2 text-right font-medium">{money(r.price)}</td>
                    <td className="px-2 text-right"><Change bps={r.bps} className="justify-end" /></td>
                    <td className="px-2 text-right">{peText(r.pe)}</td>
                    <td className={`px-2 text-right ${f2.epsTtm !== null && f2.epsTtm < 0 ? 'text-down' : ''}`}>{f2.epsTtm === null ? 'N/A' : eps(f2.epsTtm)}</td>
                    <td className={`hidden px-2 text-right 2xl:table-cell ${tone(f2.epsGrowth ?? 0)}`}>{ratio(f2.epsGrowth)}</td>
                    <td className={`hidden px-2 text-right 2xl:table-cell ${tone(f2.revenueGrowth ?? 0)}`}>{ratio(f2.revenueGrowth)}</td>
                    <td className={`hidden px-2 text-right min-[1800px]:table-cell ${r.margin !== null && r.margin < 0 ? 'text-down' : ''}`}>{r.margin === null ? 'N/A' : `${r.margin < 0 ? '−' : ''}${Math.abs(r.margin * 100).toFixed(1)}%`}</td>
                    <td className="px-2 text-right text-ink-2">{vsFairText(r.vsFair)}</td>
                    <td className="hidden px-2 text-right lg:table-cell">{r.trades || <span className="text-ink-3">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 text-[11px] text-ink-3">
        Prices are the game&apos;s simulated market. Financials are simulated quarters scaled to each real company&apos;s size, not its reported figures. N/A means the figure is not available, never zero.
      </p>
    </section>
  );
}
