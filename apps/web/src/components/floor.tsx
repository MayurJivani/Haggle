import { motion } from 'motion/react';
import { ArrowDownUp, Minus, Plus, Search, Star } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { eps, millions, money, pct, ratio, SECTOR_COLOR, signedMoney, tone, when } from '../lib/format';
import { game, useGame, type Report } from '../lib/game';
import { usePortfolio } from '../lib/portfolio';
import { peText, SECTOR_NOTES, useResearch, type Metrics } from '../lib/research';
import { concerns, PriceChart } from './chart';
import { Change, Pnl, useMedia } from './chrome';
import { NewsItem } from './side';

// ---------------------------------------------------------------- discovery

type Sort = 'sector' | 'change' | 'price' | 'pe' | 'growth' | 'value';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'sector', label: 'Sector' },
  { id: 'change', label: 'Change' },
  { id: 'price', label: 'Price' },
  { id: 'pe', label: 'P/E' },
  { id: 'growth', label: 'Earnings growth' },
  { id: 'value', label: 'Price vs fair value' },
];
type Show = 'all' | 'favourites' | 'held' | 'recent';

const sortKey = (m: Metrics, s: Sort): number | null => {
  switch (s) {
    case 'change': return m.bps;
    case 'price': return m.price;
    case 'pe': return typeof m.pe === 'number' ? m.pe : null;
    case 'growth': return m.asset.fund.epsGrowth;
    case 'value': return m.vsFair;
    default: return 0;
  }
};

function FavStar({ ticker, size = 16 }: { ticker: string; size?: number }) {
  const on = useGame((s) => s.favourites.includes(ticker));
  return (
    <button
      type="button"
      onClick={() => game.toggleFavourite(ticker)}
      aria-pressed={on}
      aria-label={on ? `Remove ${ticker} from favourites` : `Add ${ticker} to favourites`}
      className={`grid h-11 w-9 shrink-0 place-items-center ${on ? 'text-saffron' : 'text-ink-3 hover:text-ink'}`}
    >
      <Star size={size} fill={on ? 'currentColor' : 'none'} aria-hidden />
    </button>
  );
}

function StockRow({ m, selected, onSelect, readOnly, held }: { m: Metrics; selected: boolean; onSelect?: (t: string) => void; readOnly: boolean; held: number }) {
  const prev = useGame((s) => s.prev[m.index]);
  const moved = m.price - (prev ?? m.price);
  const Row = readOnly ? 'div' : 'button';
  return (
    <li className={`flex items-stretch [contain-intrinsic-size:auto_48px] [content-visibility:auto] ${selected ? 'bg-night-4' : ''}`}>
      {!readOnly && <FavStar ticker={m.asset.ticker} size={14} />}
      <Row
        {...(readOnly ? {} : { type: 'button' as const, onClick: () => onSelect?.(m.asset.ticker), 'aria-current': selected ? ('true' as const) : undefined })}
        className={`grid min-h-12 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-x-3 py-1.5 pr-3 text-left ${readOnly ? 'pl-4' : 'hover:bg-night-3'}`}
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SECTOR_COLOR[m.asset.sector] }} aria-hidden />
            <span className="text-[14px] font-bold">{m.asset.ticker}</span>
            {held > 0 && (
              <span className="rounded-sm bg-saffron-deep px-1 text-[11px] font-semibold text-saffron" title={`You hold ${held}`}>{held}</span>
            )}
          </span>
          <span className="block truncate text-[12px] text-ink-3">{m.asset.name}</span>
        </span>
        <span className="text-right">
          <span key={prev} className={`block rounded-sm text-[14px] font-medium ${moved > 0 ? 'flash-up' : moved < 0 ? 'flash-down' : ''}`}>{money(m.price)}</span>
          <span className="block text-[11px] text-ink-3" title="Simulated-price P/E">P/E {peText(m.pe)}</span>
        </span>
        <Change bps={m.bps} className="justify-end text-[12px]" />
      </Row>
    </li>
  );
}

export function StockList({ selected, onSelect, readOnly = false }: { selected?: string; onSelect?: (t: string) => void; readOnly?: boolean }) {
  const { rows } = useResearch();
  const favourites = useGame((s) => s.favourites);
  const recent = useGame((s) => s.recent);
  const p = usePortfolio();
  const [q, setQ] = useState('');
  const [sector, setSector] = useState('');
  const [sort, setSort] = useState<Sort>('sector');
  const [desc, setDesc] = useState(true);
  const [show, setShow] = useState<Show>('all');
  const sectors = useMemo(() => [...new Set(rows.map((r) => r.asset.sector))], [rows]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (sector && r.asset.sector !== sector) return false;
      if (show === 'favourites' && !favourites.includes(r.asset.ticker)) return false;
      if (show === 'held' && !(p.byTicker.get(r.asset.ticker)?.qty ?? 0)) return false;
      if (show === 'recent' && !recent.includes(r.asset.ticker)) return false;
      return !needle || `${r.asset.ticker} ${r.asset.name} ${r.asset.sector} ${r.asset.industry}`.toLowerCase().includes(needle);
    });
    if (show === 'recent') out = recent.flatMap((t) => out.filter((r) => r.asset.ticker === t));
    else if (sort !== 'sector') {
      // Companies without the figure (no earnings, no fair value) sort last either way.
      out = [...out].sort((a, b) => {
        const x = sortKey(a, sort);
        const y = sortKey(b, sort);
        if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
        return desc ? y - x : x - y;
      });
    }
    return out;
  }, [rows, q, sector, show, sort, desc, favourites, recent, p.byTicker]);

  const filtered = q || sector || show !== 'all';
  const grouped = sort === 'sector' && show !== 'recent';
  const groups = grouped ? sectors.map((s) => [s, list.filter((r) => r.asset.sector === s)] as const).filter(([, r]) => r.length) : [['', list] as const];

  if (!rows.length) return <p className="px-4 py-6 text-sm text-ink-3">Loading the listing</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-rule px-3 py-3">
        <label className="relative block">
          <span className="sr-only">Search companies</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${rows.length} companies by name or ticker`}
            className="h-10 w-full rounded-md border border-rule bg-night pl-9 pr-3 text-[16px] text-ink placeholder:text-ink-3 focus:border-saffron/60 focus:outline-none sm:text-sm"
          />
        </label>
        {!readOnly && (
          <div role="group" aria-label="Show" className="flex gap-1 overflow-x-auto">
            {(['all', 'favourites', 'held', 'recent'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={show === id}
                onClick={() => setShow(id)}
                className={`h-7 shrink-0 rounded-full border px-2.5 text-[12px] font-semibold capitalize ${show === id ? 'border-ink-3 bg-night-4 text-ink' : 'border-rule text-ink-3 hover:text-ink'}`}
              >
                {id === 'held' ? 'My holdings' : id}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Sector</span>
            <select value={sector} onChange={(e) => setSector(e.target.value)} className="h-9 w-full rounded-md border border-rule bg-night px-2 text-[13px] text-ink focus:border-saffron/60 focus:outline-none">
              <option value="">All sectors</option>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 w-full rounded-md border border-rule bg-night px-2 text-[13px] text-ink focus:border-saffron/60 focus:outline-none">
              {SORTS.map((s) => <option key={s.id} value={s.id}>Sort: {s.label}</option>)}
            </select>
          </label>
          <button
            type="button"
            disabled={sort === 'sector'}
            onClick={() => setDesc((d) => !d)}
            aria-label={desc ? 'Sorted high to low; switch to low to high' : 'Sorted low to high; switch to high to low'}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-rule text-ink-2 hover:text-ink disabled:opacity-35"
          >
            <ArrowDownUp size={15} className={desc ? '' : 'rotate-180'} aria-hidden />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {list.length === 0 && (
          <div className="px-4 py-6 text-sm text-ink-2">
            <p>
              {show === 'favourites' ? 'No favourites yet. Star a company to keep it here.' : show === 'held' ? 'You hold nothing yet.' : show === 'recent' ? 'Companies you open appear here.' : `No company matches "${q}".`}
            </p>
            {filtered && (
              <button type="button" onClick={() => { setQ(''); setSector(''); setShow('all'); }} className="mt-2 font-semibold text-saffron hover:underline">
                Show all {rows.length} companies
              </button>
            )}
          </div>
        )}
        {groups.map(([name, items]) => (
          <section key={name || 'all'} aria-label={name || 'Companies'} style={{ ['--stripe' as string]: SECTOR_COLOR[name] }}>
            {name && (
              <div className="sticky top-0 z-10 bg-night-2">
                <div className="awning h-1.5" aria-hidden />
                <div className="flex items-center justify-between px-4 pb-1 pt-2">
                  <h3 className="font-display text-[15px] font-bold uppercase tracking-[0.06em]" style={{ color: 'var(--stripe)' }}>{name}</h3>
                  <Change bps={Math.round(items.reduce((s, r) => s + r.bps, 0) / items.length)} className="text-[12px]" />
                </div>
              </div>
            )}
            <ul>
              {items.map((m) => (
                <StockRow key={m.asset.ticker} m={m} selected={selected === m.asset.ticker} onSelect={onSelect} readOnly={readOnly} held={p.byTicker.get(m.asset.ticker)?.qty ?? 0} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The lobby shows the listing too, without trading controls. */
export const StallList = StockList;

// ---------------------------------------------------------------- sectors

export function SectorList({ onSector }: { onSector: (s: string) => void }) {
  const { rows, sectorPe } = useResearch();
  const events = useGame((s) => s.events);
  const sectors = useMemo(() => {
    const names = [...new Set(rows.map((r) => r.asset.sector))];
    return names
      .map((name) => {
        const rs = rows.filter((r) => r.asset.sector === name);
        return { name, n: rs.length, bps: Math.round(rs.reduce((s, r) => s + r.bps, 0) / rs.length), pe: sectorPe.get(name) ?? null };
      })
      .sort((a, b) => b.bps - a.bps);
  }, [rows, sectorPe]);
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1">
      {sectors.map((s) => {
        const stories = events.filter((e) => e.target === s.name).length;
        return (
          <li key={s.name} style={{ ['--stripe' as string]: SECTOR_COLOR[s.name] }}>
            <button type="button" onClick={() => onSector(s.name)} className="grid min-h-12 w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left hover:bg-night-3">
              <span className="awning h-4 w-5 rounded-[2px]" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-semibold">{s.name}</span>
                <span className="block text-[12px] text-ink-3">
                  {s.n} companies · median P/E {s.pe === null ? 'N/A' : s.pe.toFixed(1)}{stories ? ` · ${stories} ${stories === 1 ? 'story' : 'stories'}` : ''}
                </span>
              </span>
              <Change bps={s.bps} className="text-[13px] font-semibold" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SectorPanel({ sector, onSelect }: { sector: string; onSelect: (t: string) => void }) {
  const { rows, sectorPe } = useResearch();
  const events = useGame((s) => s.events);
  const members = rows.filter((r) => r.asset.sector === sector).sort((a, b) => b.bps - a.bps);
  const tickers = new Set(members.map((m) => m.asset.ticker));
  const news = events.filter((e) => e.target === sector || e.related.some((t) => tickers.has(t)));
  const avg = members.length ? Math.round(members.reduce((s, r) => s + r.bps, 0) / members.length) : 0;
  const spread = members.length ? Math.max(...members.map((m) => Math.abs(m.bps))) || 1 : 1;
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto" style={{ ['--stripe' as string]: SECTOR_COLOR[sector] }}>
      <div className="awning h-2" aria-hidden />
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-4">
        <h2 className="font-display text-[40px] font-black uppercase leading-[0.9]" style={{ color: 'var(--stripe)' }}>{sector}</h2>
        <div className="text-right text-[13px] text-ink-3">
          <Change bps={avg} className="text-[18px] font-semibold" />
          <p>average since the bell · median P/E {sectorPe.get(sector)?.toFixed(1) ?? 'N/A'}</p>
        </div>
      </div>
      <p className="max-w-[65ch] px-4 pt-2 text-[13px] leading-relaxed text-ink-2">{SECTOR_NOTES[sector]}</p>
      <h3 className="panel-title px-4 pb-1 pt-4">Companies, relative performance</h3>
      <ul className="px-2">
        {members.map((m) => (
          <li key={m.asset.ticker}>
            <button type="button" onClick={() => onSelect(m.asset.ticker)} className="grid min-h-11 w-full grid-cols-[4.5rem_minmax(0,1fr)_minmax(4rem,30%)_4.5rem] items-center gap-3 rounded-md px-2 text-left hover:bg-night-3">
              <span className="text-[14px] font-bold">{m.asset.ticker}</span>
              <span className="truncate text-[13px] text-ink-3">{m.asset.name} · P/E {peText(m.pe)}</span>
              <span className="relative h-2 rounded-full bg-night-4" aria-hidden>
                <span
                  className={`absolute top-0 h-2 rounded-full ${m.bps >= 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down'}`}
                  style={{ width: `${(Math.abs(m.bps) / spread) * 50}%` }}
                />
              </span>
              <Change bps={m.bps} className="justify-end text-[12px]" />
            </button>
          </li>
        ))}
      </ul>
      <h3 className="panel-title px-4 pb-1 pt-4">Recent sector news</h3>
      {news.length ? (
        <ol className="px-1 pb-4">{news.slice(0, 12).map((ev) => <NewsItem key={ev.id} ev={ev} onSelect={onSelect} />)}</ol>
      ) : (
        <p className="px-4 pb-4 text-sm text-ink-3">No stories about this sector yet. Economy-wide news is in the crier.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- company research

const reportCache = new Map<string, Report[]>();

function useReports(ticker: string, latest: string) {
  const key = `${ticker}:${latest}`;
  const [reports, setReports] = useState<Report[] | null>(() => reportCache.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setReports(reportCache.get(key) ?? null);
    setFailed(false);
    fetch(`/api/companies/${ticker}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ reports: Report[] }>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        reportCache.set(key, d.reports);
        if (live) setReports(d.reports);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [key, ticker]);
  return { reports, failed };
}

const q = (r: Report) => `Q${r.fiscalQuarter} FY${r.fiscalYear}`;

function Financials({ m }: { m: Metrics }) {
  const f = m.asset.fund;
  const { sectorPe } = useResearch();
  const latest = f.latest ? `${f.latest.fiscalYear}-${f.latest.fiscalQuarter}` : 'none';
  const { reports, failed } = useReports(m.asset.ticker, latest);
  const sPe = sectorPe.get(m.asset.sector) ?? null;
  const quarters = (reports ?? []).slice(-8).reverse();
  const years = useMemo(() => {
    const byYear = new Map<number, Report[]>();
    for (const r of reports ?? []) byYear.set(r.fiscalYear, [...(byYear.get(r.fiscalYear) ?? []), r]);
    // Only complete fiscal years: a year with a missing quarter is not summed into a fake total.
    const full = [...byYear].filter(([, rs]) => rs.length === 4).map(([fy, rs]) => ({
      fy, revenue: rs.reduce((s, r) => s + r.revenue, 0), ni: rs.reduce((s, r) => s + r.netIncome, 0), eps: rs.reduce((s, r) => s + r.eps, 0),
    }));
    return full.sort((a, b) => b.fy - a.fy).slice(0, 3);
  }, [reports]);
  const fair = f.fair;
  const premium = m.vsFair === null ? null : m.vsFair - 1;
  return (
    <div className="flex flex-col gap-5 px-4 pb-6 pt-3 text-[13px]">
      <section aria-label="Valuation">
        <h3 className="panel-title pb-2">Valuation</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fig label="Simulated-price P/E" value={peText(m.pe)} hint={m.pe === 'N/M' ? 'Negative earnings' : m.pe === 'N/A' ? 'Not enough reported quarters' : 'Game price / trailing EPS'} />
          <Fig label="Sector median P/E" value={sPe === null ? 'N/A' : sPe.toFixed(1)} hint={typeof m.pe === 'number' && sPe ? `${m.pe > sPe ? 'Above' : 'Below'} the sector` : undefined} />
          <Fig label="Trailing EPS" value={f.epsTtm === null ? 'N/A' : eps(f.epsTtm)} hint="Last four quarters" />
          <Fig label="EPS growth" value={ratio(f.epsGrowth)} tone={f.epsGrowth ?? 0} hint={`Revenue ${ratio(f.revenueGrowth)}`} />
        </dl>
        {fair ? (
          <div className="mt-4 rounded-md border border-rule bg-night px-3 py-3">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-ink-3">Model fair value</span>
              <span className="text-[18px] font-semibold">{money(fair.cents)}</span>
              {premium !== null && (
                <span className={tone(-premium)}>
                  price is {Math.abs(premium * 100).toFixed(0)}% {premium >= 0 ? 'above' : 'below'} it
                </span>
              )}
              {m.cheaperThan !== null && <span className="text-ink-3">· cheaper than {Math.round(m.cheaperThan * 100)}% of the listing by this measure</span>}
            </p>
            <p className="mt-1.5 leading-relaxed text-ink-2">
              {fair.basis === 'earnings' ? 'Trailing EPS' : 'Sales per share'} × a {fair.multiple.toFixed(1)}x multiple: the sector&apos;s {fair.sectorMultiple}x blended with
              this company&apos;s own {fair.historicalMultiple}x, {fair.growthFactor >= 1 ? 'raised' : 'lowered'} {Math.abs((fair.growthFactor - 1) * 100).toFixed(0)}% for growth and{' '}
              {fair.riskFactor >= 1 ? 'raised' : 'lowered'} {Math.abs((fair.riskFactor - 1) * 100).toFixed(0)}% for risk.
              {fair.basis === 'sales' ? ' Loss-makers are valued on sales at a discount.' : ''}
            </p>
            <p className="mt-1.5 text-[12px] text-ink-3">A simulated estimate from the game&apos;s model. Not a price target and not financial advice: profitable companies can still be expensive.</p>
          </div>
        ) : (
          <p className="mt-3 text-ink-3">No fair value: the model needs four consecutive reported quarters.</p>
        )}
      </section>

      <section aria-label="Quarterly results">
        <h3 className="panel-title pb-2">Quarterly results</h3>
        {failed && !reports ? (
          <p className="text-ink-3">Results did not load. Switching tabs will retry.</p>
        ) : !reports ? (
          <p className="text-ink-3">Loading results</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-right">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <tr>
                  <th scope="col" className="py-1 text-left font-medium">Quarter</th>
                  <th scope="col" className="py-1 font-medium">Revenue</th>
                  <th scope="col" className="py-1 font-medium">Net income</th>
                  <th scope="col" className="py-1 font-medium">EPS</th>
                  <th scope="col" className="py-1 font-medium">Estimate</th>
                  <th scope="col" className="py-1 font-medium">Surprise</th>
                </tr>
              </thead>
              <tbody>
                {quarters.map((r) => {
                  const surprise = r.epsEstimate ? (r.eps - r.epsEstimate) / Math.abs(r.epsEstimate) : null;
                  return (
                    <tr key={q(r)} className="border-t border-rule/60">
                      <th scope="row" className="py-1.5 text-left font-semibold">
                        {q(r)} <span className="font-normal text-ink-3">{when(r.reportedAt)}</span>
                      </th>
                      <td>{millions(r.revenue)}</td>
                      <td className={r.netIncome < 0 ? 'text-down' : ''}>{millions(r.netIncome)}</td>
                      <td>{eps(r.eps)}</td>
                      <td className="text-ink-3">{r.epsEstimate === null ? 'N/A' : eps(r.epsEstimate)}</td>
                      <td className={tone(surprise ?? 0)}>{ratio(surprise)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {years.length > 0 && (
        <section aria-label="Annual results">
          <h3 className="panel-title pb-2">Annual results</h3>
          <table className="w-full text-right">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3">
              <tr>
                <th scope="col" className="py-1 text-left font-medium">Fiscal year</th>
                <th scope="col" className="py-1 font-medium">Revenue</th>
                <th scope="col" className="py-1 font-medium">Net income</th>
                <th scope="col" className="py-1 font-medium">EPS</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y, k) => {
                const before = years[k + 1];
                return (
                  <tr key={y.fy} className="border-t border-rule/60">
                    <th scope="row" className="py-1.5 text-left font-semibold">FY{y.fy}</th>
                    <td>
                      {millions(y.revenue)}
                      {before && <span className={`ml-1.5 text-[12px] ${tone(y.revenue - before.revenue)}`}>{ratio(y.revenue / before.revenue - 1)}</span>}
                    </td>
                    <td className={y.ni < 0 ? 'text-down' : ''}>{millions(y.ni)}</td>
                    <td>{eps(y.eps)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <p className="text-[12px] text-ink-3">
        Simulated financials, scaled to the real company&apos;s size but not its reported figures. New quarters are filed by earnings news during play.
      </p>
    </div>
  );
}

function Fig({ label, value, hint, tone: t }: { label: string; value: string; hint?: string; tone?: number }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</dt>
      <dd className={`text-[17px] font-semibold ${t === undefined ? '' : tone(t)}`}>{value}</dd>
      {hint && <dd className="text-[12px] text-ink-3">{hint}</dd>}
    </div>
  );
}

type Tab = 'chart' | 'financials' | 'news';

export function CompanyPanel({ ticker, onSelect }: { ticker: string; onSelect: (t: string) => void }) {
  const { byTicker } = useResearch();
  const prev = useGame((s) => s.prev[s.index.get(ticker) ?? -1]);
  const events = useGame((s) => s.events);
  const p = usePortfolio();
  const [tab, setTab] = useState<Tab>('chart');
  const id = useId();
  const m = byTicker.get(ticker);
  useEffect(() => game.visit(ticker), [ticker]);
  if (!m) return null;
  const a = m.asset;
  const held = p.byTicker.get(ticker);
  const news = events.filter((e) => concerns(e, ticker, a.sector));
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ ['--stripe' as string]: SECTOR_COLOR[a.sector] }}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-4 pt-3">
        <div className="min-w-0">
          <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className="font-display text-[40px] font-black leading-[0.9] sm:text-[44px]">{a.ticker}</span>
            <span className="truncate text-lg text-ink-2">{a.name}</span>
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
            <span className="awning inline-block h-3 w-5 rounded-[2px]" aria-hidden />
            <span className="font-semibold" style={{ color: 'var(--stripe)' }}>{a.sector}</span>
            <span>{a.industry}</span>
            <span>· {a.exchange}</span>
            <span>· {a.risk} risk, beta {a.beta.toFixed(2)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <FavStar ticker={ticker} />
          <motion.span
            key={m.price}
            initial={{ y: m.price >= (prev ?? m.price) ? 5 : -5 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="tag inline-block bg-ink py-1 pr-3 font-display text-[30px] font-extrabold leading-none text-night sm:text-[34px]"
          >
            {money(m.price)}
          </motion.span>
          <div className="flex flex-col text-sm leading-tight">
            <Change bps={m.bps} className="text-[15px] font-semibold" />
            <span className="text-[12px] text-ink-3">since the bell</span>
          </div>
        </div>
      </div>
      <p className="max-w-[75ch] px-4 pt-1.5 text-[13px] text-ink-2">
        {a.description}
        {held && held.qty > 0 && (
          <span className="ml-1 text-ink">
            You hold {held.qty} at {money(Math.round(held.cost / held.qty))} (<Pnl cents={held.unrealized} />).
          </span>
        )}
      </p>
      <div role="tablist" aria-label={`${a.ticker} research`} className="mt-2 flex gap-1 border-b border-rule px-3">
        {(['chart', 'financials', 'news'] as const).map((t) => (
          <button
            key={t}
            id={`${id}-${t}`}
            role="tab"
            type="button"
            aria-selected={tab === t}
            aria-controls={`${id}-${t}-panel`}
            onClick={() => setTab(t)}
            className={`relative h-10 px-3 text-[13px] font-semibold capitalize ${tab === t ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
          >
            {t}
            {t === 'news' && news.length > 0 && <span className="ml-1 text-ink-3">{news.length}</span>}
            {tab === t && <motion.span layoutId={`${id}-tab`} className="absolute inset-x-2 bottom-0 h-[2px] bg-saffron" />}
          </button>
        ))}
      </div>
      <div id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {tab === 'chart' && (
          <div className="h-[260px] pt-2 md:h-auto md:min-h-[300px] md:flex-1">
            <PriceChart ticker={a.ticker} />
          </div>
        )}
        {tab === 'financials' && <div className="min-h-0 flex-1 overflow-y-auto"><Financials m={m} /></div>}
        {tab === 'news' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {news.length ? (
              <ol className="px-1 pb-3">{news.map((ev) => <NewsItem key={ev.id} ev={ev} onSelect={onSelect} />)}</ol>
            ) : (
              <p className="px-4 py-4 text-sm text-ink-3">No stories about {a.name}, its sector or the economy yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- order entry

export function OrderPanel({ ticker, dock = false }: { ticker: string; dock?: boolean }) {
  const { byTicker } = useResearch();
  const phase = useGame((s) => s.session?.phase);
  const conn = useGame((s) => s.conn);
  const book = useGame((s) => s.book);
  const outcome = useGame((s) => s.outcome);
  const p = usePortfolio();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qtyText, setQtyText] = useState('1');
  const [sent, setSent] = useState<string | null>(null);
  const id = useId();
  // On a short phone screen the dock starts as one row, so the research above keeps its room.
  const tall = useMedia('(min-height: 720px)');
  const [expanded, setExpanded] = useState(tall);

  const price = byTicker.get(ticker)?.price ?? 0;
  const held = p.byTicker.get(ticker);
  const owned = held?.qty ?? 0;
  // Whole shares only: the most the server would accept at this price with this cash.
  const maxBuy = price ? Math.floor(p.cash / price) : 0;
  const max = side === 'buy' ? maxBuy : owned;
  const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
  const total = Number.isFinite(qty) ? qty * price : 0;
  const mine = sent && outcome?.id === sent ? outcome : null;
  const waiting = sent !== null && !mine;

  useEffect(() => setSide((s) => (s === 'sell' && owned === 0 ? 'buy' : s)), [ticker, owned]);
  // A filled order clears the quantity; a refused one keeps it so the player can adjust and resend.
  useEffect(() => {
    if (mine?.ok) setQtyText('1');
  }, [mine]);
  useEffect(() => setSent(null), [ticker]);

  const open = phase === 'trading' || phase === 'closing';
  const problem = !book
    ? 'You are watching this competition.'
    : !open
      ? phase === 'lobby' ? 'Trading opens at the bell.' : 'The market is closed.'
      : conn !== 'open'
        ? 'Waiting for the connection.'
        : !Number.isInteger(qty) || qty < 1
          ? 'Enter a whole number of shares.'
          : side === 'buy' && total > p.cash
            ? `Not enough cash. You can afford ${maxBuy}.`
            : side === 'sell' && qty > owned
              ? owned ? `You only hold ${owned}.` : `You hold no ${ticker}.`
              : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || waiting) return;
    setSent(game.order(side, ticker, qty));
  };
  const setQty = (n: number) => setQtyText(String(Math.max(1, Math.min(n, 999_999))));
  const step = (d: number) => setQty((Number.isFinite(qty) ? qty : 0) + d);

  if (dock && !expanded) {
    return (
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="min-w-0 flex-1 text-[12px] leading-tight text-ink-3">
          <span className="block text-[15px] font-semibold text-ink">{money(price)}</span>
          {owned ? `You hold ${owned}` : `${money(p.cash)} cash`}
        </span>
        <button type="button" onClick={() => setExpanded(true)} aria-expanded={false} className="h-11 shrink-0 rounded-md bg-saffron px-5 text-[15px] font-bold text-night hover:brightness-110">
          Trade {ticker}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={`flex flex-col ${dock ? 'gap-2 px-3 pb-2 pt-2.5' : 'gap-3 p-4'}`} aria-label={`Order ${ticker}`}>
      <div className="flex items-center gap-3">
        <div role="radiogroup" aria-label="Side" className="grid flex-1 grid-cols-2 rounded-md bg-night p-1">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={side === s}
              onClick={() => setSide(s)}
              className={`relative ${dock ? 'h-9' : 'h-10'} rounded-[5px] text-sm font-bold uppercase tracking-[0.08em] ${side === s ? 'text-night' : 'text-ink-2 hover:text-ink'}`}
            >
              {side === s && (
                <motion.span layoutId={`${id}-side`} className={`absolute inset-0 rounded-[5px] ${s === 'buy' ? 'bg-saffron' : 'bg-down'}`} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
              )}
              <span className="relative">{s}</span>
            </button>
          ))}
        </div>
        {dock && (
          <span className="shrink-0 text-right text-[12px] leading-tight text-ink-3">
            <span className="block text-[14px] font-semibold text-ink">{money(price)}</span>
            {side === 'buy' ? `${money(p.cash)} cash` : `${owned} held`}
          </span>
        )}
        {dock && !tall && (
          <button type="button" onClick={() => setExpanded(false)} aria-expanded className="h-9 shrink-0 rounded-md px-2 text-[12px] font-semibold text-ink-3 hover:text-ink">
            Hide
          </button>
        )}
      </div>

      {!dock && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-ink-3">Price</dt>
          <dd className="text-right font-semibold">{money(price)}</dd>
          <dt className="text-ink-3">Available cash</dt>
          <dd className="text-right">{money(p.cash)}</dd>
          <dt className="text-ink-3">{side === 'buy' ? 'You can afford' : 'You hold'}</dt>
          <dd className="text-right">{side === 'buy' ? maxBuy : owned} shares</dd>
        </dl>
      )}

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label htmlFor={`${id}-qty`} className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-3">Shares</label>
          <span className="flex gap-1">
            {[10, 100].map((n) => (
              <button key={n} type="button" onClick={() => step(n)} className="h-7 rounded-sm px-1.5 text-[12px] font-semibold text-ink-2 hover:text-ink">
                +{n}
              </button>
            ))}
            <button
              type="button"
              disabled={max < 1}
              onClick={() => setQty(max)}
              className="h-7 rounded-sm px-1.5 text-[13px] font-semibold text-saffron hover:underline disabled:text-ink-3 disabled:no-underline"
            >
              Max {max}
            </button>
          </span>
        </div>
        <div className="flex items-stretch gap-1.5">
          <button type="button" onClick={() => step(-1)} aria-label="One fewer share" className="grid w-11 place-items-center rounded-md border border-rule bg-night hover:bg-night-3">
            <Minus size={16} aria-hidden />
          </button>
          <input
            id={`${id}-qty`}
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="go"
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            className="h-11 min-w-0 flex-1 rounded-md border border-rule bg-night text-center text-lg font-semibold focus:border-saffron/60 focus:outline-none"
          />
          <button type="button" onClick={() => step(1)} aria-label="One more share" className="grid w-11 place-items-center rounded-md border border-rule bg-night hover:bg-night-3">
            <Plus size={16} aria-hidden />
          </button>
        </div>
      </div>

      <p className="flex justify-between text-[13px] text-ink-3">
        <span>
          Estimated {side === 'buy' ? 'cost' : 'proceeds'} <span className="font-semibold text-ink">{money(total)}</span>
        </span>
        <span>
          Cash after{' '}
          <span className={`font-semibold ${side === 'buy' && total > p.cash ? 'text-down' : 'text-ink'}`}>
            {money(Math.max(0, side === 'buy' ? p.cash - total : p.cash + total))}
          </span>
        </span>
      </p>

      <button
        type="submit"
        disabled={!!problem || waiting}
        className={`${dock ? 'h-11' : 'h-12'} rounded-md text-[15px] font-bold text-night transition-[filter,opacity] hover:brightness-110 disabled:opacity-35 ${side === 'buy' ? 'bg-saffron' : 'bg-down'}`}
      >
        {waiting ? 'Sending order' : `${side === 'buy' ? 'Buy' : 'Sell'} ${Number.isFinite(qty) && qty > 0 ? qty : ''} ${ticker}`}
      </button>
      <p className="min-h-[1.25rem] text-[13px] text-ink-2" aria-live="polite">
        {mine ? (
          <span className={mine.ok ? 'text-ink' : 'text-saffron'}>{mine.text}</span>
        ) : problem ? (
          problem
        ) : owned > 0 && held ? (
          <span className="flex flex-wrap justify-between gap-x-3">
            <span>
              You hold <strong className="text-ink">{owned}</strong> at {money(Math.round(held.cost / owned))}
            </span>
            <Pnl cents={held.unrealized} className="font-semibold" />
          </span>
        ) : (
          <span className="text-ink-3">Market order at the current simulated price. Orders never move the price.</span>
        )}
      </p>
    </form>
  );
}

// ---------------------------------------------------------------- portfolio

function SellAll() {
  const p = usePortfolio();
  const phase = useGame((s) => s.session?.phase);
  const [confirm, setConfirm] = useState(false);
  const open = phase === 'trading' || phase === 'closing';
  if (!p.holdings.length) return null;
  if (!confirm) {
    return (
      <button type="button" disabled={!open} onClick={() => setConfirm(true)} className="h-8 rounded-md border border-rule px-3 text-[13px] font-semibold text-ink-2 hover:border-down/60 hover:text-down disabled:opacity-35">
        Sell all
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2 text-[13px]" role="group" aria-label="Confirm selling everything">
      <span className="text-ink-2">Sell all {p.holdings.length} at market for about {money(p.invested)}?</span>
      <button
        type="button"
        onClick={() => {
          for (const h of p.holdings) game.order('sell', h.asset.ticker, h.qty);
          setConfirm(false);
        }}
        className="h-8 rounded-md bg-down px-3 font-bold text-night hover:brightness-110"
      >
        Sell all
      </button>
      <button type="button" onClick={() => setConfirm(false)} className="h-8 rounded-md px-2 font-semibold text-ink-2 hover:text-ink">
        Keep
      </button>
    </span>
  );
}

function Transactions({ onSelect }: { onSelect: (t: string) => void }) {
  const trades = useGame((s) => s.trades);
  if (!trades.length) return <p className="px-4 pb-4 text-sm text-ink-2">No trades in this competition yet.</p>;
  return (
    <div className="overflow-x-auto px-2 pb-3">
      <table className="w-full min-w-[30rem] text-[13px]">
        <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
          <tr>
            <th scope="col" className="px-2 py-1.5 font-medium">Time</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Order</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Shares</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Price</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Total</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Realised</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-t border-rule/60">
              <td className="px-2 py-1.5 text-ink-3">{when(t.at)}</td>
              <td className="px-2 py-1.5">
                <span className={`mr-1.5 text-[11px] font-bold uppercase ${t.side === 'buy' ? 'text-saffron' : 'text-down'}`}>{t.side}</span>
                <button type="button" onClick={() => onSelect(t.ticker)} className="font-semibold hover:text-saffron">{t.ticker}</button>
              </td>
              <td className="px-2 py-1.5 text-right">{t.qty}</td>
              <td className="px-2 py-1.5 text-right">{money(t.price)}</td>
              <td className="px-2 py-1.5 text-right">{t.side === 'buy' ? '−' : '+'}{money(t.total)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(t.realized)}`}>{t.side === 'sell' ? signedMoney(t.realized) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Holdings({ onSelect }: { onSelect: (t: string) => void }) {
  const p = usePortfolio();
  const [view, setView] = useState<'holdings' | 'trades'>('holdings');
  const rows = p.holdings.slice().sort((a, b) => b.value - a.value);
  return (
    <div className="flex min-h-0 flex-col">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-rule px-4 py-4 sm:grid-cols-5">
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Portfolio value</dt>
          <dd className="font-display text-4xl font-extrabold leading-none sm:text-3xl">{money(p.value)}</dd>
          <dd className="mt-1 text-[13px]"><Pnl cents={p.pnl} className="font-semibold" /> <span className={tone(p.bps)}>{pct(p.bps)}</span></dd>
        </div>
        <Fig label="Cash" value={money(p.cash)} />
        <Fig label="Invested" value={money(p.invested)} />
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Unrealised P/L</dt>
          <dd className="text-[17px] font-semibold"><Pnl cents={p.unrealized} /></dd>
          <dd className="text-[12px] text-ink-3">on shares still held</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Realised P/L</dt>
          <dd className="text-[17px] font-semibold"><Pnl cents={p.realized} /></dd>
          <dd className="text-[12px] text-ink-3">locked in by sales</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <div role="tablist" aria-label="Portfolio" className="flex gap-1">
          {(['holdings', 'trades'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`h-8 rounded-md px-3 font-display text-[15px] font-bold uppercase tracking-[0.06em] ${view === v ? 'bg-night-4 text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              {v === 'holdings' ? `Holdings ${rows.length ? rows.length : ''}` : 'Transactions'}
            </button>
          ))}
        </div>
        {view === 'holdings' && <SellAll />}
      </div>
      {view === 'trades' ? (
        <Transactions onSelect={onSelect} />
      ) : rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">All cash so far. Cash is safe, but it never climbs the roster: research a company and buy a few shares.</p>
      ) : (
        <>
          <ul className="px-2 pb-3 md:hidden">
            {rows.map((h) => (
              <li key={h.asset.ticker}>
                <button type="button" onClick={() => onSelect(h.asset.ticker)} className="flex min-h-14 w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left active:bg-night-3">
                  <span className="flex items-center gap-2.5">
                    <span className="h-8 w-1.5 rounded-full" style={{ background: SECTOR_COLOR[h.asset.sector] }} aria-hidden />
                    <span>
                      <span className="block text-[15px] font-bold">{h.asset.ticker}</span>
                      <span className="block text-[13px] text-ink-3">{h.qty} at {money(Math.round(h.cost / h.qty))} · now {money(h.price)}</span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-[15px] font-semibold">{money(h.value)}</span>
                    <Pnl cents={h.unrealized} className="text-[13px]" />
                    <span className={`ml-1 text-[12px] ${tone(h.unrealized)}`}>{pct(Math.round((h.unrealized * 10_000) / h.cost))}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden min-h-0 overflow-auto px-2 pb-2 md:block">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">Company</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Shares</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Avg cost</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Price</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Value</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Unrealised</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Realised</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.asset.ticker} className="border-t border-rule/60">
                    <td className="px-2 py-1.5">
                      <button type="button" onClick={() => onSelect(h.asset.ticker)} className="flex items-center gap-2 font-bold hover:text-saffron">
                        <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SECTOR_COLOR[h.asset.sector] }} aria-hidden />
                        {h.asset.ticker}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 text-right">{h.qty}</td>
                    <td className="px-2 py-1.5 text-right text-ink-2">{money(Math.round(h.cost / h.qty))}</td>
                    <td className="px-2 py-1.5 text-right">{money(h.price)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{money(h.value)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <Pnl cents={h.unrealized} />
                      <span className={`ml-1.5 text-[12px] ${tone(h.unrealized)}`}>{pct(Math.round((h.unrealized * 10_000) / h.cost))}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">{h.realized ? <Pnl cents={h.realized} /> : <span className="text-ink-3">None</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
