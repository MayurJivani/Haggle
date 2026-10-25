import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'motion/react';
import { Check, Copy, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { clock, money, moneyWhole, ordinal, pct, SECTOR_COLOR, tone } from '../lib/format';
import { useGame, type PlayerResult, type SessionInfo } from '../lib/game';
import { Pnl, SimulatedChip, useNow, Wordmark, leave } from './chrome';
import { StallList } from './floor';
import { PURSE, STARTING_CASH } from '../lib/portfolio';

const ease = [0.16, 1, 0.3, 1] as const;
const AWNINGS = Object.values(SECTOR_COLOR);

/** A row of awning panels in every sector colour: the market's flag. */
function AwningRow({ className = '', grow = false }: { className?: string; grow?: boolean }) {
  return (
    <div className={`flex ${className}`} aria-hidden>
      {AWNINGS.map((c, i) => (
        <motion.div
          key={c}
          className="awning h-full flex-1 origin-top"
          style={{ ['--stripe' as string]: c }}
          initial={grow ? { scaleY: 0 } : false}
          animate={{ scaleY: 1 }}
          transition={{ delay: 0.05 * i, duration: 0.7, ease }}
        />
      ))}
    </div>
  );
}

export function Splash({ text = 'Opening the market' }: { text?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-night px-6">
      <div className="flex flex-col items-center gap-5">
        <Wordmark className="text-6xl" />
        <AwningRow className="h-3 w-56 animate-pulse" />
        <p className="text-sm text-ink-2" role="status">{text}</p>
      </div>
    </div>
  );
}

export function Join({ session, offset, onJoined }: { session: SessionInfo | null; offset: number; onJoined: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useNow(offset, 1000);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: name }) });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? 'Could not join. Try again.');
      onJoined();
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : 'Haggle is not reachable right now. Check your connection.');
    } finally {
      setBusy(false);
    }
  };

  const status = !session
    ? null
    : session.phase === 'lobby'
      ? `Next bell in ${clock(session.opensAt - t)}. ${session.players} traders waiting.`
      : session.phase === 'results'
        ? 'Results are in. You will be dealt into the next session.'
        : `Market open, ${clock(session.closesAt - t)} left. ${session.players} trading. Late arrivals still get ${PURSE}.`;

  return (
    <main className="flex min-h-dvh flex-col bg-night">
      <AwningRow className="h-10 sm:h-14" grow />
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-8 px-5 py-10">
        <div>
          <h1>
            <Wordmark className="block text-[clamp(4rem,16vw,8.5rem)]" />
          </h1>
          <p className="mt-4 max-w-md text-lg text-ink-2">
            A live stock market for the whole room. Everyone gets {PURSE}. The fattest purse at the closing bell wins.
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="nick" className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">
            Your trader name
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="nick"
              autoFocus
              required
              minLength={2}
              maxLength={20}
              autoComplete="nickname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!error}
              aria-describedby="nick-help"
              placeholder="e.g. Saffron Sam"
              className="h-14 min-w-0 flex-1 rounded-md border border-rule bg-night-2 px-4 text-xl font-semibold placeholder:font-normal placeholder:text-ink-3 focus:border-saffron/70 focus:outline-none"
            />
            <button type="submit" disabled={busy || name.trim().length < 2} className="h-14 rounded-md bg-saffron px-6 text-lg font-bold text-night hover:brightness-110 disabled:opacity-40">
              {busy ? 'Joining' : 'Enter the market'}
            </button>
          </div>
          <p id="nick-help" className={`text-sm ${error ? 'text-down' : 'text-ink-3'}`} role={error ? 'alert' : undefined}>
            {error ?? 'This device remembers you, so you can reconnect any time during the session.'}
          </p>
        </form>
        {status && (
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-up" aria-hidden />
            {status}
          </p>
        )}
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
          <SimulatedChip /> Virtual money only. Company names are real; every price and headline is simulated.
        </p>
      </div>
    </main>
  );
}

export function Lobby() {
  const session = useGame((s) => s.session)!;
  const offset = useGame((s) => s.offset);
  const you = useGame((s) => s.you);
  const spectating = useGame((s) => s.spectating);
  const listed = useGame((s) => s.assets.length);
  const t = useNow(offset);
  const left = session.opensAt - t;
  const minutes = Math.round((session.closesAt - session.opensAt) / 60_000);
  return (
    <main className="flex min-h-dvh flex-col bg-night lg:h-dvh lg:flex-row">
      <section className="flex flex-1 flex-col">
        <AwningRow className="h-10 sm:h-14" />
        <div className="flex flex-1 flex-col justify-center gap-8 px-5 py-10 sm:px-10">
          <div className="flex items-center justify-between gap-4">
            <Wordmark className="text-4xl" />
            <SimulatedChip />
          </div>
          <p className="flex flex-wrap items-baseline gap-x-5 font-display font-black leading-[0.85]" role="timer">
            <span className="text-[clamp(2.5rem,7vw,5rem)] uppercase text-ink">Bell in</span>
            <span className="text-[clamp(6rem,22vw,13rem)] text-saffron">{clock(left)}</span>
          </p>
          <p className="max-w-2xl text-xl leading-relaxed text-ink-2">
            <strong className="text-ink">{session.players}</strong> {session.players === 1 ? 'trader' : 'traders'} at the stalls
            {session.players >= session.maxPlayers ? ' (full)' : ''}.{' '}
            {spectating ? (
              'This session is full, so you are watching.'
            ) : (
              <>
                <strong className="text-ink">{PURSE}</strong> in your purse at the bell,
              </>
            )}{' '}
            then <strong className="text-ink">{minutes} minutes</strong> of trading before the final bell.
          </p>
          <ol className="grid max-w-2xl gap-2 text-[15px] text-ink-2 sm:grid-cols-3 sm:gap-5">
            <li><strong className="text-ink">Buy and sell</strong> any of {listed} companies at the live simulated price.</li>
            <li><strong className="text-ink">Listen to the crier.</strong> News hits everyone at once and moves whole sectors.</li>
            <li><strong className="text-ink">Cash plus shares</strong> at the closing price decides the roster.</li>
          </ol>
          <p className="text-sm text-ink-3">
            Trading as <strong className="text-ink">{you?.nickname}</strong>.{' '}
            <button type="button" onClick={() => void leave()} className="underline decoration-ink-3 underline-offset-4 hover:text-ink">
              Not you? Change name
            </button>
          </p>
        </div>
      </section>
      <aside className="border-t border-rule bg-night-2 lg:h-dvh lg:w-[380px] lg:border-l lg:border-t-0" aria-label="Opening prices">
        <h2 className="panel-title px-4 pt-4">Opening prices</h2>
        <div className="h-[420px] lg:h-[calc(100dvh-2.75rem)]">
          <StallList readOnly />
        </div>
      </aside>
    </main>
  );
}

/** The opening bell: awnings unroll across the screen, the market opens, then it lifts away. */
export function Bell() {
  const bellAt = useGame((s) => s.bellAt);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!bellAt || Date.now() - bellAt > 4000) return;
    setShow(true);
    const id = setTimeout(() => setShow(false), 2900);
    return () => clearTimeout(id);
  }, [bellAt]);
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 z-50 flex cursor-pointer flex-col bg-night/95"
          onClick={() => setShow(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: -40, transition: { duration: 0.5, ease } }}
          role="alert"
        >
          <AwningRow className="h-[38vh]" grow />
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <motion.p
              initial={{ y: 40, opacity: 0, letterSpacing: '0.2em' }}
              animate={{ y: 0, opacity: 1, letterSpacing: '0.01em' }}
              transition={{ delay: 0.35, duration: 0.8, ease }}
              className="font-display text-[clamp(3.5rem,12vw,9rem)] font-black uppercase leading-[0.85]"
            >
              The market is <span className="text-saffron">open</span>
            </motion.p>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9 }} className="text-lg text-ink-2">
              {PURSE} in your purse. Prices are simulated. Go.
            </motion.p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CountUp({ cents, delay = 0 }: { cents: number; delay?: number }) {
  const v = useMotionValue(useGame((s) => s.session?.startingCash ?? STARTING_CASH));
  const text = useTransform(v, (x) => moneyWhole(Math.round(x)));
  useEffect(() => {
    const c = animate(v, cents, { delay, duration: 1.4, ease });
    return () => c.stop();
  }, [cents, delay, v]);
  return <motion.span>{text}</motion.span>;
}

const AWARD_COPY: Record<string, string> = { winner: 'Top of the market', steady: 'Steadiest hand', crier: 'Read the crier' };

export function ResultCard({ r, share = true }: { r: PlayerResult; share?: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/r/${r.participantId}`;
  const doShare = async () => {
    const text = `I finished ${ordinal(r.rank)} of ${r.of} at Haggle with ${money(r.value)} (${pct(r.bps)}).`;
    try {
      if (navigator.share) return await navigator.share({ title: 'Haggle', text, url });
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the user closed the share sheet */
    }
  };
  return (
    <article className="overflow-hidden rounded-lg bg-night-2" aria-label={`Result for ${r.nickname}`}>
      <AwningRow className="h-3" />
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-display text-7xl font-black leading-[0.85]">
              {ordinal(r.rank)}
              <span className="ml-2 text-2xl font-bold text-ink-3">of {r.of}</span>
            </p>
            <p className="mt-2 text-lg font-semibold">{r.nickname}</p>
          </div>
          <div className="text-right">
            <p className="font-display text-4xl font-extrabold leading-none">{money(r.value)}</p>
            <p className={`mt-1 text-lg font-semibold ${tone(r.bps)}`}>{pct(r.bps)}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-3">Profit</dt>
            <dd><Pnl cents={r.value - (r.start ?? Math.round((r.value * 10_000) / (10_000 + r.bps)))} className="font-semibold" /></dd>
          </div>
          <div>
            <dt className="text-ink-3">Trades</dt>
            <dd className="font-semibold">{r.trades}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Best holding</dt>
            <dd className="font-semibold">{r.best ? <>{r.best.ticker} <Pnl cents={r.best.pnl} /></> : '–'}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Largest loss</dt>
            <dd className="font-semibold">{r.worst ? <>{r.worst.ticker} <Pnl cents={r.worst.pnl} /></> : '–'}</dd>
          </div>
        </dl>
        {r.awards.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {r.awards.map((a) => (
              <li key={a} className="rounded-sm bg-saffron px-2 py-1 text-[13px] font-bold uppercase tracking-[0.06em] text-night">
                {AWARD_COPY[a] ?? a}
              </li>
            ))}
          </ul>
        )}
        {share && (
          <button type="button" onClick={() => void doShare()} className="flex h-11 items-center justify-center gap-2 rounded-md border border-rule font-semibold hover:border-saffron/60 hover:text-saffron">
            {copied ? <Check size={17} aria-hidden /> : 'share' in navigator ? <Share2 size={17} aria-hidden /> : <Copy size={17} aria-hidden />}
            {copied ? 'Link copied' : 'Share my result'}
          </button>
        )}
        <p className="text-[12px] text-ink-3">Simulated market, virtual money. Session of {new Date(r.finishedAt).toLocaleString()}.</p>
      </div>
    </article>
  );
}

export function Results() {
  const results = useGame((s) => s.results);
  const session = useGame((s) => s.session);
  const offset = useGame((s) => s.offset);
  const t = useNow(offset, 1000);
  if (!results) return <Splash text="The final bell has rung. Counting every purse at the same closing prices." />;
  const podium = [results.top[1], results.top[0], results.top[2]];
  const heights = ['h-28', 'h-40', 'h-20'];
  const order = [1, 2, 0]; // reveal third, then second, then first
  return (
    <main className="min-h-dvh bg-night">
      <AwningRow className="h-8" />
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8 sm:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Wordmark className="text-3xl" />
            <h1 className="mt-2 font-display text-[clamp(3rem,10vw,6.5rem)] font-black uppercase leading-[0.85]">The market is closed</h1>
          </div>
          {session?.nextAt && <p className="text-ink-2">Next session opens in <span className="font-semibold text-ink">{clock(session.nextAt - t)}</span></p>}
        </header>

        {results.top.length > 0 && (
          <section aria-label="Podium" className="grid grid-cols-3 items-end gap-2 sm:gap-4">
            {podium.map((r, col) =>
              r ? (
                <motion.div
                  key={r.participantId}
                  initial={{ opacity: 0, y: 60 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 + order[col]! * 0.7, type: 'spring', stiffness: 180, damping: 18 }}
                  className="flex flex-col items-center gap-2 text-center"
                >
                  <p className="max-w-full truncate text-base font-bold sm:text-xl">{r.nickname}</p>
                  <p className="font-display text-xl font-extrabold sm:text-3xl"><CountUp cents={r.value} delay={0.6 + order[col]! * 0.7} /></p>
                  <p className={`text-sm font-semibold ${tone(r.bps)}`}>{pct(r.bps)}</p>
                  <div
                    className={`awning flex w-full items-start justify-center rounded-t-md pt-2 ${heights[col]}`}
                    style={{ ['--stripe' as string]: col === 1 ? 'var(--color-saffron)' : col === 0 ? 'var(--color-ink-2)' : 'var(--color-ink-3)' }}
                  >
                    <span className="rounded-sm bg-night px-2 font-display text-3xl font-black">{r.rank}</span>
                  </div>
                </motion.div>
              ) : (
                <div key={col} />
              ),
            )}
          </section>
        )}

        <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
          <section aria-label="Your result">
            <h2 className="panel-title mb-3">Your purse</h2>
            {results.me ? (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 2.6, duration: 0.6, ease }}>
                <ResultCard r={results.me} />
              </motion.div>
            ) : (
              <p className="rounded-lg bg-night-2 p-5 text-ink-2">You watched this one. You will be dealt into the next session automatically.</p>
            )}
          </section>
          <section aria-label="Final roster" className="flex flex-col gap-6">
            {results.awards.length > 0 && (
              <div>
                <h2 className="panel-title mb-3">Awards</h2>
                <ul className="flex flex-col gap-2">
                  {results.awards.map((a) => (
                    <li key={a.id} className="flex items-baseline justify-between gap-3 rounded-md bg-night-2 px-4 py-3">
                      <span className="font-display text-xl font-bold uppercase text-saffron">{a.label}</span>
                      <span className="text-right">
                        <span className="font-semibold">{a.nickname}</span>
                        <span className="block text-[12px] text-ink-3">{a.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h2 className="panel-title mb-3">Final roster</h2>
              {results.top.length === 0 && <p className="rounded-lg bg-night-2 p-5 text-ink-2">Nobody traded this session. The next bell deals in everyone who is connected.</p>}
              <ol className="flex flex-col">
                {results.top.map((r) => (
                  <li key={r.participantId} className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto_4.5rem] items-baseline gap-2 border-b border-rule/60 py-2">
                    <span className="font-display text-2xl font-extrabold">{r.rank}</span>
                    <span className="truncate font-semibold">{r.nickname}</span>
                    <span>{money(r.value)}</span>
                    <span className={`text-right text-sm ${tone(r.bps)}`}>{pct(r.bps)}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[13px] text-ink-3">Every purse valued at the same closing prices. Ties go to whoever joined first.</p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

export function ShareCard({ id }: { id: string }) {
  const [state, setState] = useState<{ r?: PlayerResult; error?: string }>({});
  useEffect(() => {
    fetch(`/api/results/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const body = (await res.json()) as { result?: PlayerResult; error?: string };
        setState(res.ok && body.result ? { r: body.result } : { error: body.error ?? 'Result not found' });
      })
      .catch(() => setState({ error: 'Haggle is not reachable right now.' }));
  }, [id]);
  if (!state.r && !state.error) return <Splash text="Fetching the result" />;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-night px-4 py-10">
      <Wordmark className="text-5xl" />
      <div className="w-full max-w-xl">
        {state.r ? <ResultCard r={state.r} share={false} /> : <p className="rounded-lg bg-night-2 p-6 text-center text-ink-2">{state.error}. The link may be from a session that never finished.</p>}
      </div>
      <a href="/" className="rounded-md bg-saffron px-6 py-3 font-bold text-night hover:brightness-110">
        Play Haggle
      </a>
    </main>
  );
}
