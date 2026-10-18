import { AnimatePresence, motion } from 'motion/react';
import { useRef } from 'react';
import { clock, money, ordinal, pct, SECTOR_COLOR, tone } from '../lib/format';
import { X } from 'lucide-react';
import { game, useGame, type EventInfo } from '../lib/game';
import { useMedia } from './chrome';

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const;
/** Where the feed is on screen next to the floor; on phones it lives in another tab, so nothing docks. */
const DOCK_QUERY = '(min-width: 768px)';

export function Roster() {
  const board = useGame((s) => s.board);
  const you = useGame((s) => s.you?.nickname);
  const meInTop = board.top.some((r) => r.nickname === you);
  return (
    <section aria-label="Leaderboard" className="flex flex-col">
      <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
        <h2 className="panel-title">Roster</h2>
        <span className="text-[12px] text-ink-3">{board.count} {board.count === 1 ? 'trader' : 'traders'}</span>
      </div>
      {board.top.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">Nobody at the stalls yet.</p>
      ) : (
        <ol className="px-2 pb-2">
          {board.top.map((r) => (
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

/** The colour an event is called out in: its sector's awning, or saffron for the whole market. */
export function eventColor(ev: EventInfo, sectorOf: (t: string) => string | undefined) {
  if (ev.scope === 'sector') return SECTOR_COLOR[ev.target ?? ''] ?? 'var(--color-saffron)';
  if (ev.scope === 'asset') return SECTOR_COLOR[sectorOf(ev.target ?? '') ?? ''] ?? 'var(--color-saffron)';
  return 'var(--color-saffron)';
}

function Effects({ ev, onSelect, limit = 4 }: { ev: EventInfo; onSelect?: (t: string) => void; limit?: number }) {
  const top = [...ev.effects].sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps)).slice(0, limit);
  return (
    <span className="flex flex-wrap gap-1">
      {top.map((e) => (
        <button
          key={e.ticker}
          type="button"
          onClick={() => onSelect?.(e.ticker)}
          className={`rounded-sm px-1.5 py-0.5 text-[12px] font-semibold ${e.bps > 0 ? 'bg-up-deep text-up' : 'bg-down-deep text-down'} hover:brightness-125`}
        >
          {e.ticker} {pct(e.bps)}
        </button>
      ))}
      {ev.effects.length > limit && <span className="self-center text-[12px] text-ink-3">+{ev.effects.length - limit} more</span>}
    </span>
  );
}

export function Feed({ onSelect }: { onSelect: (t: string) => void }) {
  const events = useGame((s) => s.events);
  // The event the crier is still calling waits off the list; when the banner clears it docks here.
  const calling = useGame((s) => s.crier?.seq);
  const dock = useMedia(DOCK_QUERY);
  const assets = useGame((s) => s.assets);
  const tickMs = useGame((s) => s.session?.tickMs ?? 1000);
  const sectorOf = (t: string) => assets.find((a) => a.ticker === t)?.sector;
  return (
    <section aria-label="Market news" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
        <h2 className="panel-title">The crier</h2>
        <span className="text-[12px] text-ink-3">{events.length} calls</span>
      </div>
      {events.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">Quiet so far. News lands here for every trader at the same moment.</p>
      ) : (
        <ol data-dock className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <AnimatePresence initial={false}>
            {[...events].reverse().filter((ev) => !(dock && ev.seq === calling)).map((ev) => (
              <motion.li
                key={ev.seq}
                layout="position"
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
                className="border-b border-rule/60 px-2 py-2.5 last:border-0"
                style={{ ['--stripe' as string]: eventColor(ev, sectorOf) }}
              >
                <div className="mb-1 flex items-center gap-2 text-[12px] text-ink-3">
                  <span className="awning h-2.5 w-5 rounded-[2px]" aria-hidden />
                  <span>T+{clock(ev.tick * tickMs)}</span>
                  <Severity level={ev.severity} />
                </div>
                <p className="text-[14px] font-semibold leading-snug" title={ev.description}>{ev.headline}</p>
                <div className="mt-1.5">
                  <Effects ev={ev} onSelect={onSelect} limit={3} />
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </section>
  );
}

/**
 * The signature move: when news breaks, an awning-striped band sweeps across every screen at once,
 * the affected stalls pulse in the list, and after a few seconds it folds away into the feed.
 */
export function Crier({ onSelect }: { onSelect: (t: string) => void }) {
  const crier = useGame((s) => s.crier);
  const assets = useGame((s) => s.assets);
  const dock = useMedia(DOCK_QUERY);
  const wide = useMedia('(min-width: 640px)');
  const sectorOf = (t: string) => assets.find((a) => a.ticker === t)?.sector;
  const band = useRef<HTMLDivElement>(null);
  // Measured on the render that clears the crier, while the band is still on screen: where the
  // feed's first slot is, so the band lands there instead of at a guessed offset.
  const target = (() => {
    const b = band.current?.getBoundingClientRect();
    const f = dock ? document.querySelector('[data-dock]')?.getBoundingClientRect() : undefined;
    return b && f ? { x: f.left - b.left, y: f.top - b.top, scale: Math.min(1, f.width / b.width) } : null;
  })();
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 px-2 pt-2 sm:px-3" aria-live="assertive">
      <AnimatePresence custom={target}>
        {crier && (
          <motion.div
            key={crier.seq}
            ref={band}
            custom={target}
            variants={{
              // Docking: the band flies into the feed's first slot while the held-back item enters there.
              gone: (t: typeof target) =>
                t
                  ? { ...t, opacity: 0.2, transition: { duration: 0.55, ease: [0.65, 0, 0.35, 1] } }
                  : { opacity: 0, y: -16, transition: { duration: 0.35 } },
            }}
            initial={{ clipPath: 'inset(0 100% 0 0)' }}
            animate={{ clipPath: 'inset(0 0% 0 0)' }}
            exit="gone"
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            role="alert"
            className="pointer-events-auto overflow-hidden rounded-md bg-night-3 shadow-[0_18px_40px_rgba(0,0,0,0.55)]"
            style={{ ['--stripe' as string]: eventColor(crier, sectorOf), transformOrigin: 'left top' }}
          >
            <div className={`awning ${crier.severity === 3 ? 'h-3' : 'h-2'}`} aria-hidden />
            <div className="relative flex flex-col gap-2 py-2.5 pl-3 pr-11 sm:flex-row sm:items-center sm:gap-5 sm:px-4 sm:py-3">
              <div className="hidden shrink-0 items-center gap-2 sm:flex">
                <Severity level={crier.severity} />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`font-display font-extrabold uppercase leading-[0.95] tracking-[0.01em] ${crier.severity === 3 ? 'text-[24px] sm:text-[34px]' : 'text-[20px] sm:text-[26px]'}`}>
                  {crier.headline}
                </p>
                <p className="mt-1 hidden text-[13px] text-ink-2 sm:block">{crier.description}</p>
              </div>
              <button
                type="button"
                onClick={() => game.dismissCrier()}
                aria-label="Dismiss news"
                className="absolute right-1.5 top-3.5 grid h-9 w-9 place-items-center rounded-md text-ink-3 hover:bg-night-4 hover:text-ink sm:static sm:order-last"
              >
                <X size={18} aria-hidden />
              </button>
              <div className="shrink-0">
                <Effects ev={crier} onSelect={onSelect} limit={crier.scope === 'asset' ? 1 : wide ? 5 : 3} />
              </div>
            </div>
            <motion.div
              className="h-[2px] origin-left bg-[var(--stripe)]"
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: 7, ease: 'linear' }}
              aria-hidden
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
