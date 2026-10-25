import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownRight, ArrowUpRight, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { changeBps, clock, money, ordinal, pct, signedMoney, tone } from '../lib/format';
import { game, now, useGame, type SessionInfo } from '../lib/game';
import { usePortfolio } from '../lib/portfolio';

/** Tracks a CSS media query, so a panel renders in exactly one place per layout. */
export function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function useNow(offset: number, every = 250) {
  const [t, setT] = useState(() => now(offset));
  useEffect(() => {
    const id = setInterval(() => setT(now(offset)), every);
    return () => clearInterval(id);
  }, [offset, every]);
  return t;
}

export function Arrow({ value, size = 14 }: { value: number; size?: number }) {
  if (value === 0) return null;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return <Icon size={size} strokeWidth={2.25} aria-hidden className="shrink-0" />;
}

export function Change({ bps, className = '' }: { bps: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 tabular-nums ${tone(bps)} ${className}`}>
      <Arrow value={bps} />
      {pct(bps)}
    </span>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-black uppercase leading-none tracking-[0.02em] ${className}`}>
      Ha<span className="text-saffron">gg</span>le
    </span>
  );
}

export function SimulatedChip() {
  return (
    <span
      className="rounded-sm border border-rule px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2"
      title="Company names are real. Prices, news and money are simulated."
    >
      <span className="sm:hidden">Simulated</span>
      <span className="hidden sm:inline">Simulated market</span>
    </span>
  );
}

const PHASE_LABEL: Record<SessionInfo['phase'], string> = {
  lobby: 'Bell in',
  trading: 'Market open',
  closing: 'Last calls',
  results: 'Closed',
};

function Countdown({ session, offset }: { session: SessionInfo; offset: number }) {
  const t = useNow(offset);
  const target = session.phase === 'lobby' ? session.opensAt : session.phase === 'results' ? (session.nextAt ?? t) : session.closesAt;
  const elapsed = Math.min(1, Math.max(0, (t - session.opensAt) / (session.closesAt - session.opensAt)));
  const closing = session.phase === 'closing';
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <div className="flex items-baseline gap-2" role="timer" aria-live="off">
        <span className={`hidden text-[11px] font-semibold uppercase tracking-[0.1em] min-[420px]:inline ${closing ? 'text-down' : 'text-ink-2'}`}>
          {PHASE_LABEL[session.phase]}
        </span>
        <span className={`font-display text-2xl font-bold leading-none ${closing ? 'text-down' : 'text-ink'}`}>{clock(target - t)}</span>
      </div>
      <div className="h-[3px] w-32 overflow-hidden rounded-full bg-night-4 sm:w-44" aria-hidden>
        <div
          className={`h-full origin-left ${closing ? 'bg-down' : 'bg-saffron'}`}
          style={{ transform: `scaleX(${session.phase === 'lobby' ? 0 : elapsed})`, transition: 'transform 0.25s linear' }}
        />
      </div>
    </div>
  );
}

function Stat({ label, children, className = '', title }: { label: string; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <div title={title} className={`flex flex-col items-end whitespace-nowrap leading-tight ${className}`}>
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</span>
      <span className="text-[15px] font-semibold">{children}</span>
    </div>
  );
}

/** The whole market at a glance: the equal-weighted change of every company since the bell. */
function MarketIndex() {
  const prices = useGame((s) => s.prices);
  const open = useGame((s) => s.open);
  const regime = useGame((s) => s.regime);
  const bps = useMemo(() => {
    let sum = 0;
    let n = 0;
    prices.forEach((p, i) => {
      if (open[i]) {
        sum += changeBps(p, open[i]!);
        n++;
      }
    });
    return n ? Math.round(sum / n) : 0;
  }, [prices, open]);
  return (
    <Stat label="Market" className="hidden md:flex" title={`Equal-weighted change of every company since the bell. Volatility: ${regime}.`}>
      <Change bps={bps} />
      <span className={`ml-1.5 text-[12px] font-medium ${regime === 'calm' ? 'text-ink-3' : regime === 'nervous' ? 'text-saffron' : 'text-down'}`}>{regime}</span>
    </Stat>
  );
}

/**
 * Whether the prices on screen are current. While the market is open a tick lands every second; a
 * gap of a few seconds means the numbers are stale, and the player is told so instead of trading on them.
 */
export function useStale() {
  const phase = useGame((s) => s.session?.phase);
  const tickMs = useGame((s) => s.session?.tickMs ?? 1000);
  const receivedAt = useGame((s) => s.receivedAt);
  const conn = useGame((s) => s.conn);
  const t = useNow(0, 1000);
  const open = phase === 'trading' || phase === 'closing';
  return conn !== 'open' || (open && receivedAt > 0 && t - receivedAt > tickMs * 4);
}

export function TopBar() {
  const session = useGame((s) => s.session);
  const offset = useGame((s) => s.offset);
  const board = useGame((s) => s.board);
  const book = useGame((s) => s.book);
  const at = useGame((s) => s.at);
  const stale = useStale();
  const p = usePortfolio();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-rule bg-night-2 px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Wordmark className="hidden whitespace-nowrap text-[26px] lg:inline" />
        <span className="flex flex-col items-start gap-0.5">
          <SimulatedChip />
          <span className={`hidden text-[11px] sm:block ${stale ? 'font-semibold text-saffron' : 'text-ink-3'}`} role="status">
            {stale ? 'Prices delayed' : at ? `Updated ${new Date(at).toLocaleTimeString()}` : ''}
          </span>
        </span>
      </div>
      {session && <Countdown session={session} offset={offset} />}
      <div className="flex items-center gap-4 sm:gap-6">
        <MarketIndex />
        {book ? (
          <>
            <Stat label="Value">
              {money(p.value)}
              <span className="ml-1 hidden text-[13px] lg:inline">
                <Change bps={p.bps} />
              </span>
            </Stat>
            <Stat label="Cash" className="hidden sm:flex">{money(book.cash)}</Stat>
            <Stat label="Rank">
              {board.me ? (
                <>
                  {ordinal(board.me.rank)}
                  <span className="text-ink-3"> / {board.count}</span>
                </>
              ) : (
                '–'
              )}
            </Stat>
          </>
        ) : (
          <Stat label="Traders">{board.count}</Stat>
        )}
      </div>
    </header>
  );
}

export function ConnectionPill() {
  const conn = useGame((s) => s.conn);
  const has = useGame((s) => s.session !== null);
  return (
    <AnimatePresence>
      {has && conn !== 'open' && (
        <motion.div
          role="status"
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-saffron/40 bg-saffron-deep px-4 py-2 text-sm text-ink shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
        >
          <WifiOff size={16} className="text-saffron" aria-hidden />
          Reconnecting. Your portfolio is safe on the server.
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-3 z-40 hidden flex-col items-end gap-2 md:flex" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className={`rounded-md border bg-night-3 px-3.5 py-2.5 text-sm font-medium shadow-[0_10px_30px_rgba(0,0,0,0.5)] ${
              t.tone === 'up' ? 'border-up/40 text-up' : t.tone === 'down' ? 'border-down/40 text-down' : 'border-saffron/40 text-saffron'
            }`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Signed money with its arrow, for P/L figures. */
export function Pnl({ cents, className = '' }: { cents: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${tone(cents)} ${className}`}>
      <Arrow value={cents} size={13} />
      {signedMoney(cents)}
    </span>
  );
}

export const leave = async () => {
  await fetch('/api/leave', { method: 'POST' });
  game.stop();
  location.reload();
};
