import { AnimatePresence, motion } from 'motion/react';
import { Lock, Users } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { clock, money, pct, tone } from '../lib/format';
import type { Board, EventInfo, Results, SessionInfo } from '../lib/game';
import { PURSE } from '../lib/portfolio';
import { SimulatedChip, useNow, Wordmark } from './chrome';

interface HostView {
  serverNow: number;
  session: SessionInfo | null;
  board: Pick<Board, 'top' | 'count'>;
  events: EventInfo[];
  results: Pick<Results, 'top' | 'awards'> | null;
}

// The host code lives for this tab only: a shared laptop at an event should not remember it.
const KEY = 'haggle-host-code';
const readCode = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

async function call(code: string, path: string, method: 'GET' | 'POST' = 'GET') {
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${code}` } });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

function Gate({ onCode }: { onCode: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await call(code.trim(), '/api/host');
      if (!r.ok) return setError(r.status === 404 ? 'Hosting is switched off on this server (no ADMIN_TOKEN set).' : 'That host code is not right.');
      try {
        sessionStorage.setItem(KEY, code.trim());
      } catch {
        /* private mode: the code just lasts until reload */
      }
      onCode(code.trim());
    } catch {
      setError('The server is not reachable right now.');
    }
  };
  return (
    <main className="grid min-h-dvh place-items-center bg-night px-5">
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-4">
        <Wordmark className="text-6xl" />
        <h1 className="text-lg text-ink-2">Host console. Enter the host code to run the room.</h1>
        <label htmlFor="code" className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">
          Host code
        </label>
        <input
          id="code"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={!!error}
          aria-describedby="code-help"
          className="h-14 rounded-md border border-rule bg-night-2 px-4 text-lg focus:border-saffron/70 focus:outline-none"
        />
        <p id="code-help" className={`text-sm ${error ? 'text-down' : 'text-ink-3'}`} role={error ? 'alert' : undefined}>
          {error ?? 'The ADMIN_TOKEN from the server environment. It stays in this tab only.'}
        </p>
        <button type="submit" disabled={code.trim().length < 8} className="h-14 rounded-md bg-saffron text-lg font-bold text-night hover:brightness-110 disabled:opacity-40">
          Open the console
        </button>
      </form>
    </main>
  );
}

const PHASE: Record<SessionInfo['phase'], string> = {
  lobby: 'Bell in',
  trading: 'Market open',
  closing: 'Last calls',
  results: 'Next round in',
};

function Console({ code, onLock }: { code: string; onLock: () => void }) {
  const [view, setView] = useState<HostView | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useNow(offset);
  const joinUrl = `${location.origin}/play`;

  const load = useCallback(async () => {
    try {
      const r = await call(code, '/api/host');
      if (r.status === 401) return onLock();
      if (!r.ok) throw new Error();
      setView(r.body as HostView);
      setOffset((r.body as HostView).serverNow - Date.now());
      setError(null);
    } catch {
      setError('Lost contact with the server. Retrying.');
    }
  }, [code, onLock]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 1000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    const r = await call(code, path, 'POST').catch(() => null);
    setBusy(false);
    if (!r?.ok) setError(r?.status === 409 ? 'Too late for that: the round already moved on.' : 'That did not go through. Try again.');
    void load();
  };

  const s = view?.session;
  const target = !s ? t : s.phase === 'lobby' ? s.opensAt : s.phase === 'results' ? (s.nextAt ?? t) : s.closesAt;
  const action = !s
    ? null
    : s.phase === 'lobby'
      ? { label: 'Open the bell now', path: '/api/admin/start', disabled: s.players === 0, hint: s.players === 0 ? 'Waiting for the first trader to scan in.' : `${s.players} ${s.players === 1 ? 'trader' : 'traders'} ready.` }
      : s.phase === 'results'
        ? { label: 'Start the next round now', path: '/api/admin/next', disabled: !s.nextAt, hint: s.nextAt ? 'Everyone connected is dealt in.' : 'Counting the purses.' }
        : { label: 'Close the market now', path: '/api/admin/close', confirm: 'Ring the final bell now? Every purse is valued at the current prices and trading stops for everyone.', disabled: false, hint: 'Ends the round early at the current prices.' };

  return (
    <main className="flex min-h-dvh flex-col bg-night">
      <header className="flex items-center justify-between gap-3 border-b border-rule bg-night-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Wordmark className="text-3xl" />
          <span className="hidden text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-2 sm:inline">Host</span>
          <SimulatedChip />
        </div>
        <button type="button" onClick={onLock} className="flex h-10 items-center gap-2 rounded-md px-3 text-sm text-ink-2 hover:bg-night-3 hover:text-ink">
          <Lock size={16} aria-hidden />
          Lock console
        </button>
      </header>

      {error && (
        <p className="bg-down-deep px-4 py-2 text-center text-sm text-down" role="alert">
          {error}
        </p>
      )}

      {!view ? (
        <p className="grid flex-1 place-items-center text-ink-2" role="status">
          Connecting to the room
        </p>
      ) : (
        <div className="grid flex-1 gap-px bg-rule lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section className="flex flex-col gap-8 bg-night p-5 sm:p-8" aria-label="Round">
            <div>
              <p className={`text-[13px] font-semibold uppercase tracking-[0.1em] ${s?.phase === 'closing' ? 'text-down' : 'text-ink-2'}`}>{s ? PHASE[s.phase] : 'Setting up'}</p>
              <p className={`font-display text-[clamp(6rem,16vw,12rem)] font-black leading-[0.85] ${s?.phase === 'closing' ? 'text-down' : 'text-saffron'}`} role="timer">
                {clock(target - t)}
              </p>
            </div>
            <p className="flex items-center gap-3 text-xl text-ink-2">
              <Users size={22} aria-hidden />
              <span>
                <strong className="font-display text-4xl font-extrabold text-ink">{s?.players ?? 0}</strong> {s?.players === 1 ? 'trader' : 'traders'} in the room, {PURSE} each
              </span>
            </p>
            {action && (
              <div className="flex max-w-md flex-col gap-2">
                <button
                  type="button"
                  disabled={busy || action.disabled}
                  onClick={() => void act(action.path, action.confirm)}
                  className={`h-16 rounded-md text-xl font-bold text-night hover:brightness-110 disabled:opacity-40 ${s?.phase === 'trading' || s?.phase === 'closing' ? 'bg-down' : 'bg-saffron'}`}
                >
                  {busy ? 'Sending' : action.label}
                </button>
                <p className="text-sm text-ink-2">{action.hint}</p>
              </div>
            )}
            {s?.phase === 'results' && view.results && view.results.awards.length > 0 && (
              <ul className="flex max-w-xl flex-col gap-2" aria-label="Awards">
                {view.results.awards.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
                    <span className="font-display text-2xl font-bold uppercase text-saffron">{a.label}</span>
                    <span className="text-right text-lg font-semibold">
                      {a.nickname}
                      <span className="block text-[13px] font-normal text-ink-3">{a.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto grid gap-6 md:grid-cols-2">
              <div>
                <h2 className="panel-title mb-2">{s?.phase === 'results' ? 'Final roster' : 'Roster'}</h2>
                {view.board.top.length === 0 ? (
                  <p className="text-sm text-ink-2">Nobody on the roster yet.</p>
                ) : (
                  <ol>
                    <AnimatePresence initial={false}>
                      {view.board.top.slice(0, 8).map((r) => (
                        <motion.li key={r.nickname} layout="position" className="grid grid-cols-[2rem_minmax(0,1fr)_auto_4.5rem] items-baseline gap-2 py-1">
                          <span className={`font-display text-2xl font-extrabold leading-none ${r.rank === 1 ? 'text-saffron' : 'text-ink-3'}`}>{r.rank}</span>
                          <span className="truncate font-semibold">{r.nickname}</span>
                          <span className="text-sm">{money(r.value)}</span>
                          <span className={`text-right text-sm ${tone(r.bps)}`}>{pct(r.bps)}</span>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ol>
                )}
              </div>
              <div>
                <h2 className="panel-title mb-2">The crier</h2>
                {view.events.length === 0 ? (
                  <p className="text-sm text-ink-2">No news yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {view.events.slice(0, 4).map((ev) => (
                      <li key={ev.seq} className="text-[15px] font-semibold leading-snug">
                        {ev.headline}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section className="flex flex-col items-center justify-center gap-6 bg-night-2 p-6 text-center sm:p-10" aria-label="Join">
            <h2 className="font-display text-[clamp(2.5rem,5vw,4.5rem)] font-black uppercase leading-[0.9]">
              Scan to <span className="text-saffron">join</span>
            </h2>
            <div className="rounded-lg bg-ink p-4 shadow-[0_18px_40px_rgba(0,0,0,0.45)] sm:p-5">
              <QRCodeSVG value={joinUrl} size={320} bgColor="#f1eadb" fgColor="#0d0b19" level="M" marginSize={0} title={`Join at ${joinUrl}`} className="h-auto w-[min(70vw,320px)]" />
            </div>
            <p className="break-all font-display text-[clamp(1.5rem,3vw,2.5rem)] font-bold">{joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</p>
            <p className="max-w-sm text-ink-2">Pick a trader name on your phone. You get {PURSE} of virtual money at the bell. Prices are simulated.</p>
          </section>
        </div>
      )}
    </main>
  );
}

export function Host() {
  const [code, setCode] = useState<string | null>(readCode);
  const lock = useCallback(() => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing stored */
    }
    setCode(null);
  }, []);
  return code ? <Console code={code} onLock={lock} /> : <Gate onCode={setCode} />;
}
