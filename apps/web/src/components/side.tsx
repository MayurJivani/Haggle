import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { money, ordinal, pct, SECTOR_COLOR, tone, when } from '../lib/format';
import { game, useGame, type EventInfo } from '../lib/game';
import { usePortfolio } from '../lib/portfolio';

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const;

export function Roster({ limit = 10 }: { limit?: number }) {
  const board = useGame((s) => s.board);
  const you = useGame((s) => s.you?.nickname);
  const rows = board.top.slice(0, limit);
  const meInTop = rows.some((r) => r.nickname === you);
  return (
    <section aria-label="Leaderboard" className="flex flex-col">
      <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
        <h2 className="panel-title">Roster</h2>
        <span className="text-[12px] text-ink-3">ranked by return · {board.count} {board.count === 1 ? 'trader' : 'traders'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">Nobody at the stalls yet.</p>
      ) : (
        <ol className="px-2 pb-2">
          {rows.map((r) => (
            <motion.li
              key={r.nickname}
              layout="position"
              transition={spring}
              className={`grid grid-cols-[2rem_minmax(0,1fr)_auto_4.25rem] items-baseline gap-2 rounded-md px-2 py-1 ${r.nickname === you ? 'bg-saffron-deep' : ''}`}
              title={`${r.trades} ${r.trades === 1 ? 'trade' : 'trades'}${r.top ? `, mostly ${r.top}` : ', all cash'}`}
            >
              <span className={`font-display text-xl font-extrabold leading-none ${r.rank === 1 ? 'text-saffron' : r.rank <= 3 ? 'text-ink' : 'text-ink-3'}`}>
                {r.rank}
              </span>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-[14px] font-semibold">{r.nickname}</span>
                {r.nickname === you && <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-saffron">you</span>}
                <span className="shrink-0 text-[12px] text-ink-3">{r.top ?? 'cash'}</span>
              </span>
              <span className="text-[13px]">{money(r.value)}</span>
              <span className={`text-right text-[12px] ${tone(r.bps)}`}>{pct(r.bps)}</span>
            </motion.li>
          ))}
        </ol>
      )}
      {board.me && !meInTop && (
        <div className="mx-2 mb-2 grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-baseline gap-2 rounded-md border border-saffron/30 bg-saffron-deep px-2 py-1.5">
          <span className="font-display text-xl font-extrabold leading-none text-saffron">{board.me.rank}</span>
          <span className="text-[14px] font-semibold">
            You, {ordinal(board.me.rank)} of {board.count}
          </span>
          <span className="text-[13px]">{money(board.me.value)}</span>
        </div>
      )}
    </section>
  );
}

function Severity({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className="inline-flex gap-[3px]" aria-label={`Severity ${level} of 3`} role="img">
      {[1, 2, 3].map((n) => (
        <span key={n} className={`h-2.5 w-1 rounded-[1px] ${n <= level ? (level === 3 ? 'bg-down' : 'bg-saffron') : 'bg-night-4'}`} />
      ))}
    </span>
  );
}

const CATEGORY_LABEL: Record<EventInfo['category'], string> = { macro: 'Economy', sector: 'Sector', company: 'Company' };

/** The colour a story is filed under: its sector's awning, or saffron for the whole economy. */
export function useEventColor() {
  const assets = useGame((s) => s.assets);
  const index = useGame((s) => s.index);
  return (ev: EventInfo) => {
    if (ev.target && SECTOR_COLOR[ev.target]) return SECTOR_COLOR[ev.target]!;
    const t = ev.related[0] ?? ev.target ?? '';
    const i = index.get(t);
    return (i !== undefined && SECTOR_COLOR[assets[i]!.sector]) || 'var(--color-saffron)';
  };
}

/** One story: headline, then the briefing, figures and the companies it names, on demand. */
export function NewsItem({ ev, onSelect, open: startOpen = false }: { ev: EventInfo; onSelect?: (t: string) => void; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const color = useEventColor();
  return (
    <li className="border-b border-rule/60 last:border-0" style={{ ['--stripe' as string]: color(ev) }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full px-3 py-2.5 text-left hover:bg-night-3">
        <span className="mb-1 flex items-center gap-2 text-[12px] text-ink-3">
          <span className="awning h-2.5 w-5 shrink-0 rounded-[2px]" aria-hidden />
          <span className="font-semibold uppercase tracking-[0.06em] text-ink-2">{CATEGORY_LABEL[ev.category]}</span>
          {ev.category === 'sector' && ev.target && SECTOR_COLOR[ev.target] && <span>{ev.target}</span>}
          <time dateTime={new Date(ev.at).toISOString()}>{when(ev.at)}</time>
          <Severity level={ev.severity} />
          <ChevronRight size={14} className={`ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        </span>
        <span className="block text-[14px] font-semibold leading-snug">{ev.headline}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-[13px] text-ink-2">
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
              <button key={t} type="button" onClick={() => onSelect?.(t)} className="rounded-sm border border-rule px-1.5 py-0.5 font-semibold text-ink hover:border-saffron/60">
                {t}
              </button>
            ))}
          </p>
        </div>
      )}
    </li>
  );
}

type Filter = 'all' | 'mine' | EventInfo['category'];
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'macro', label: 'Economy' },
  { id: 'sector', label: 'Sectors' },
  { id: 'company', label: 'Companies' },
  { id: 'mine', label: 'My holdings' },
];

export function Feed({ onSelect, track = false }: { onSelect: (t: string) => void; track?: boolean }) {
  const events = useGame((s) => s.events);
  const p = usePortfolio();
  const [filter, setFilter] = useState<Filter>('all');
  // While this list is the screen the player is looking at, nothing it shows counts as unread.
  useEffect(() => {
    if (!track) return;
    game.setNewsOpen(true);
    return () => game.setNewsOpen(false);
  }, [track]);
  const shown = useMemo(() => {
    if (filter === 'all') return events;
    if (filter !== 'mine') return events.filter((e) => e.category === filter);
    const held = new Set(p.holdings.map((h) => h.asset.ticker));
    const sectors = new Set(p.holdings.map((h) => h.asset.sector));
    return events.filter((e) => e.related.some((t) => held.has(t)) || (e.target !== null && sectors.has(e.target)) || e.category === 'macro');
  }, [events, filter, p.holdings]);
  return (
    <section aria-label="Market news" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
        <h2 className="panel-title">The crier</h2>
        <span className="text-[12px] text-ink-3">simulated news</span>
      </div>
      <div role="group" aria-label="Filter news" className="flex gap-1 overflow-x-auto px-3 pb-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`h-7 shrink-0 rounded-full border px-2.5 text-[12px] font-semibold ${filter === f.id ? 'border-ink-3 bg-night-4 text-ink' : 'border-rule text-ink-3 hover:text-ink'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">
          {events.length === 0 ? 'Quiet so far. News lands here for every trader at the same moment.' : 'No stories in this filter yet.'}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
          {shown.map((ev) => <NewsItem key={ev.id} ev={ev} onSelect={onSelect} />)}
        </ol>
      )}
    </section>
  );
}

/**
 * The crier's place in the layout: one reserved strip under the top bar. Breaking news takes the strip
 * (an awning sweeps across, and the headline holds for a few seconds) and the strip then settles on
 * the latest headline. It is in the flow of the page, so it can never sit on top of the order ticket.
 */
export function NewsStrip({ onOpen }: { onOpen: () => void }) {
  const breaking = useGame((s) => s.breaking);
  const latest = useGame((s) => s.events[0] ?? null);
  const color = useEventColor();
  const ev = breaking ?? latest;
  return (
    <div className="relative h-9 shrink-0 overflow-hidden border-b border-rule bg-night" role="region" aria-label="Latest news">
      <p className="sr-only" aria-live="polite">{breaking ? `Breaking: ${breaking.headline}` : ''}</p>
      {ev ? (
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={ev.id}
            className="absolute inset-0 flex items-center"
            style={{ ['--stripe' as string]: color(ev) }}
            initial={{ clipPath: 'inset(0 100% 0 0)' }}
            animate={{ clipPath: 'inset(0 0% 0 0)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className={`awning h-full shrink-0 ${breaking ? 'w-3' : 'w-1.5'}`} aria-hidden />
            <button type="button" onClick={onOpen} className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 text-left hover:bg-night-3">
              <span className={`shrink-0 text-[11px] font-bold uppercase tracking-[0.1em] ${breaking ? 'text-saffron' : 'text-ink-3'}`}>
                {breaking ? 'Breaking' : 'Latest'}
              </span>
              <span className={`min-w-0 truncate ${breaking ? 'font-display text-[17px] font-extrabold uppercase tracking-[0.01em]' : 'text-[13px] font-semibold'}`}>
                {ev.headline}
              </span>
              <span className="ml-auto hidden shrink-0 text-[12px] text-ink-3 sm:inline">{when(ev.at)} · all news</span>
            </button>
            {breaking && (
              <button
                type="button"
                onClick={() => game.dismissBreaking()}
                aria-label="Stop calling out this story"
                className="grid h-full w-10 shrink-0 place-items-center text-ink-3 hover:bg-night-3 hover:text-ink"
              >
                <X size={16} aria-hidden />
              </button>
            )}
            {breaking && (
              <motion.span
                className="absolute bottom-0 left-0 h-[2px] w-full origin-left bg-[var(--stripe)]"
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: 9, ease: 'linear' }}
                aria-hidden
              />
            )}
          </motion.div>
        </AnimatePresence>
      ) : (
        <p className="flex h-full items-center px-4 text-[13px] text-ink-3">The crier is quiet. News reaches every trader at the same moment.</p>
      )}
    </div>
  );
}
