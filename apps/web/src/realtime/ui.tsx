import { Bell, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Change, Wordmark } from '../components/chrome';
import {
  countdown, dayBps, go, level, price, priceStatus, readNotes, STATE_LABEL, toggleWatch, useLive, useRoute,
  type ExchangeStatus, type Instrument, type PriceStatus, type Quote,
} from './store';

export function useClock(every = 1000) {
  const offset = useLive((s) => s.offset);
  const [t, setT] = useState(() => Date.now() + offset);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now() + offset), every);
    return () => clearInterval(id);
  }, [offset, every]);
  return t;
}

const STATE_TONE: Record<string, string> = {
  open: 'bg-up text-night', pre: 'bg-saffron-deep text-saffron', post: 'bg-saffron-deep text-saffron', break: 'bg-night-4 text-ink-2',
  closed: 'bg-night-4 text-ink-3', holiday: 'bg-night-4 text-ink-3',
};

export function StateBadge({ s }: { s: ExchangeStatus | undefined }) {
  if (!s) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] ${STATE_TONE[s.state]}`}>
      {s.state === 'open' && <span className="size-1.5 animate-pulse rounded-full bg-night" aria-hidden />}
      {STATE_LABEL[s.state]}
    </span>
  );
}

const QUALITY_COPY: Record<PriceStatus, [string, string]> = {
  realtime: ['Real time', 'text-up'],
  delayed: ['Delayed', 'text-saffron'],
  eod: ['End of day', 'text-saffron'],
  dev: ['Dev data, not real', 'text-down'],
  stale: ['Stale', 'text-down'],
  closed: ['Last price', 'text-ink-3'],
  none: ['No price', 'text-ink-3'],
};

/** The honesty line: what kind of price this is, how old and from where. */
export function Quality({ q, i, long = false }: { q: Quote | undefined; i: Pick<Instrument, 'exchange'>; long?: boolean }) {
  const now = useClock(5000);
  const ex = useLive((s) => s.exchanges.find((e) => e.exchange === i.exchange));
  const maxAge = useLive((s) => s.feed?.policy.maxQuoteAgeSec ?? 60);
  const st = priceStatus(q, ex, now, maxAge);
  const [label, cls] = QUALITY_COPY[st];
  const delay = q?.quality === 'delayed' && st !== 'closed' ? ` ${q.delayMin} min` : '';
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${cls}`} title={q ? `${new Date(q.at).toLocaleString()} via ${q.source}` : undefined}>
      {label}{delay}
      {long && q && <span className="ml-1.5 font-normal normal-case tracking-normal text-ink-3">as of {new Date(q.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })} · {q.source}</span>}
    </span>
  );
}

/** A price that flashes green or red when it moves. */
export function Px({ v, currency, index = false, className = '' }: { v: number | null | undefined; currency: string; index?: boolean; className?: string }) {
  const prev = useRef(v);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (prev.current != null && v != null && v !== prev.current) {
      setFlash(v > prev.current ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setFlash(''), 900);
      prev.current = v;
      return () => clearTimeout(t);
    }
    prev.current = v;
  }, [v]);
  return <span className={`tabular-nums ${flash} ${className}`}>{index ? level(v) : price(v, currency)}</span>;
}

export function DayChange({ q }: { q: Quote | undefined }) {
  const bps = dayBps(q);
  return bps === null ? <span className="text-ink-3">—</span> : <Change bps={bps} />;
}

export function WatchStar({ id }: { id: number }) {
  const on = useLive((s) => s.watch.has(id));
  return (
    <button
      type="button" aria-pressed={on} aria-label={on ? 'Remove from watchlist' : 'Add to watchlist'}
      onClick={(e) => (e.stopPropagation(), void toggleWatch(id))}
      className={`grid size-8 place-items-center rounded-md hover:bg-night-3 ${on ? 'text-saffron' : 'text-ink-3'}`}
    >
      <Star size={16} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

export function Link({ to, children, className = '' }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={`/realtime${to}`} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); go(to); } }} className={className}>
      {children}
    </a>
  );
}

export const Panel = ({ title, right, children, className = '' }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) => (
  <section className={`rounded-lg border border-rule bg-night-2 ${className}`}>
    {(title || right) && (
      <header className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
        {title && <h2 className="panel-title">{title}</h2>}
        {right}
      </header>
    )}
    {children}
  </section>
);

const NAV: [string, string][] = [
  ['', 'Overview'], ['markets', 'Markets'], ['stocks', 'Stocks'], ['watchlist', 'Watchlist'], ['portfolio', 'Portfolio'],
  ['orders', 'Orders'], ['leaderboard', 'Leaderboard'], ['history', 'History'],
];

function Notes() {
  const notes = useLive((s) => s.notes);
  const [open, setOpen] = useState(false);
  const unread = notes.filter((n) => !n.read).length;
  return (
    <div className="relative">
      <button type="button" aria-label={`Notifications, ${unread} unread`} onClick={() => (setOpen(!open), unread && void readNotes())} className="relative grid size-9 place-items-center rounded-md hover:bg-night-3">
        <Bell size={18} />
        {unread > 0 && <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-saffron px-1 text-[10px] font-bold text-night">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 max-h-96 w-80 overflow-auto rounded-lg border border-rule bg-night-2 shadow-2xl">
          {notes.length === 0 && <p className="p-4 text-sm text-ink-3">Fills, big moves on your watchlist and market opens show up here.</p>}
          {notes.map((n) => (
            <div key={n.id} className="border-b border-rule px-4 py-2.5 text-sm last:border-0">
              <p>{n.text}</p>
              <p className="text-xs text-ink-3">{new Date(n.at).toLocaleString()}</p>
            </div>
          ))}
          <div className="border-t border-rule px-4 py-2 text-right"><Link to="/settings" className="text-xs text-saffron">Notification settings</Link></div>
        </div>
      )}
    </div>
  );
}

/** Exchange clocks: each exchange's own local time and state, ticking. */
export function MarketStrip() {
  const exchanges = useLive((s) => s.exchanges);
  const now = useClock();
  return (
    <div className="flex gap-px overflow-x-auto border-b border-rule bg-rule text-xs">
      {exchanges.map((e) => {
        const left = e.state === 'open' || e.state === 'pre' || e.state === 'post' || e.state === 'break' ? e.until - now : e.nextOpen - now;
        const local = new Intl.DateTimeFormat('en-GB', { timeZone: e.tz, hour: '2-digit', minute: '2-digit' }).format(now);
        return (
          <Link key={e.exchange} to="/markets" className="flex shrink-0 items-center gap-2 bg-night px-3 py-1.5 hover:bg-night-2">
            <span className={`size-1.5 rounded-full ${e.state === 'open' ? 'bg-up' : e.state === 'pre' || e.state === 'post' ? 'bg-saffron' : 'bg-ink-3'}`} aria-hidden />
            <span className="font-semibold">{e.exchange}</span>
            <span className="tabular-nums text-ink-3">{local}</span>
            <span className="tabular-nums text-ink-2">{e.state === 'open' ? 'closes' : e.state === 'pre' ? 'opens' : e.state === 'post' ? 'ends' : e.state === 'break' ? 'resumes' : 'opens'} {countdown(left)}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function Shell({ nickname, children }: { nickname: string | null; children: React.ReactNode }) {
  const route = useRoute();
  const page = route[0] ?? '';
  const now = useClock();
  const dev = useLive((s) => s.feed?.dev);
  const conn = useLive((s) => s.conn);
  const toasts = useLive((s) => s.toasts);
  return (
    <div className="min-h-dvh pb-16 lg:pb-0">
      <header className="sticky top-0 z-30 border-b border-rule bg-night/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-2.5">
          <a href="/" aria-label="Haggle home"><Wordmark className="text-2xl" /></a>
          <nav aria-label="Game mode" className="flex rounded-md border border-rule p-0.5 text-sm">
            <a href="/" className="rounded px-2.5 py-1 text-ink-2 hover:text-ink">Classic</a>
            <span aria-current="page" className="rounded bg-saffron px-2.5 py-1 font-bold text-night">RealTime</span>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden tabular-nums text-sm text-ink-2 md:inline">{new Date(now).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            {conn !== 'open' && <span className="rounded-sm bg-down-deep px-2 py-0.5 text-xs text-down">Live prices reconnecting</span>}
            {nickname && <Notes />}
            {nickname && <Link to="/settings" className="hidden max-w-32 truncate text-sm font-semibold sm:inline">{nickname}</Link>}
          </div>
        </div>
        <nav aria-label="RealTime" className="mx-auto hidden max-w-[1500px] gap-1 px-4 lg:flex">
          {NAV.map(([to, label]) => (
            <Link key={to} to={`/${to}`} className={`border-b-2 px-3 py-2 text-sm font-semibold ${page === to ? 'border-saffron text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>{label}</Link>
          ))}
        </nav>
        <MarketStrip />
        {dev && (
          <p role="alert" className="bg-down-deep px-4 py-1.5 text-center text-xs font-semibold text-down">
            Development data feed: every price on this server is generated, not real. Configure a market data provider for real prices.
          </p>
        )}
      </header>
      <main className="mx-auto max-w-[1500px] px-3 py-4 sm:px-4">{children}</main>
      <nav aria-label="RealTime" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-rule bg-night/95 backdrop-blur lg:hidden">
        {NAV.filter(([to]) => ['', 'stocks', 'watchlist', 'portfolio', 'leaderboard'].includes(to)).map(([to, label]) => (
          <Link key={to} to={`/${to}`} className={`truncate py-3 text-center text-[11px] font-semibold ${page === to ? 'text-saffron' : 'text-ink-2'}`}>{label}</Link>
        ))}
      </nav>
      <div aria-live="polite" className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 lg:bottom-4">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-md border px-4 py-2.5 text-sm shadow-xl ${t.tone === 'up' ? 'border-up/40 bg-up-deep' : t.tone === 'down' ? 'border-down/40 bg-down-deep' : 'border-rule bg-night-3'}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

/** A fixed-height windowed list: only the rows on screen are rendered. */
export function Virtual<T>({ items, row, height = 44, max = 640, onEnd }: { items: T[]; row: (item: T, i: number) => React.ReactNode; height?: number; max?: number; onEnd?: () => void }) {
  const [top, setTop] = useState(0);
  const view = Math.min(max, items.length * height);
  const first = Math.max(0, Math.floor(top / height) - 5);
  const last = Math.min(items.length, Math.ceil((top + view) / height) + 5);
  useEffect(() => {
    if (onEnd && last >= items.length - 2 && items.length) onEnd();
  }, [last, items.length, onEnd]);
  return (
    <div style={{ height: view }} className="overflow-y-auto" onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div style={{ height: items.length * height, position: 'relative' }}>
        {items.slice(first, last).map((it, k) => (
          <div key={first + k} style={{ position: 'absolute', top: (first + k) * height, height, left: 0, right: 0 }}>{row(it, first + k)}</div>
        ))}
      </div>
    </div>
  );
}
