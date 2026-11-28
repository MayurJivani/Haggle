import { AnimatePresence, motion } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { clock, moneyWhole, pct, tone } from '../lib/format';
import type { EventScreen } from '../lib/game';
import { TraderName } from './ceremony';
import { Lattice, useNow, Wordmark } from './chrome';

const field = 'h-12 w-full rounded-md border border-rule bg-night-2 px-3 text-[16px] focus:border-saffron/70 focus:outline-none';
const label = 'text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2';
const PURSES = [1_000, 10_000, 100_000, 1_000_000];
const MINUTES = [5, 10, 15, 20, 30];
/** One colour per line on the TV; the leader's is saffron. Sector awnings are the palette's other distinct hues. */
const LINE_COLORS = ['saffron', 'technology', 'healthcare', 'energy', 'automotive', 'consumer', 'semiconductors', 'finance'].map((c) => `var(--color-${c})`);

const signedWhole = (cents: number) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + moneyWhole(Math.abs(cents));

async function post<T>(path: string, body?: unknown): Promise<{ ok: boolean; body: T & { error?: string } }> {
  const r = await fetch(path, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

// ---------------------------------------------------------------- /event: the host sets one up

/** An event is a private room tuned for a crowd: invite code only, the screen open to anyone with the link, room for hundreds. */
export function EventSetup({ signedIn, onJoined }: { signedIn: boolean; onJoined: () => void }) {
  const [name, setName] = useState('');
  const [purse, setPurse] = useState(10_000);
  const [minutes, setMinutes] = useState(15);
  const [maxPlayers, setMaxPlayers] = useState(200);
  const [lateJoin, setLateJoin] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ code: string }>('/api/rooms', {
        name, visibility: 'private', publicResults: true, reveal: true, peek: false, lateJoin, startingCash: purse, durationMinutes: minutes, maxPlayers,
      });
      if (!r.ok) throw new Error(r.body.error ?? 'The event was not created. Try again.');
      location.assign(`/event/${r.body.code}`);
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : 'Haggle is not reachable right now.');
      setBusy(false);
    }
  };

  const chip = (on: boolean) => `flex h-12 cursor-pointer items-center justify-center rounded-md border px-3 text-[15px] font-semibold ${on ? 'border-saffron bg-saffron-deep text-saffron' : 'border-rule text-ink-2 hover:text-ink'}`;

  return (
    <main className="min-h-dvh px-4 py-8 sm:px-8">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <a href="/" aria-label="Haggle home"><Wordmark /></a>
        <header>
          <h1 className="font-display text-[clamp(2.5rem,7vw,4rem)] font-black uppercase leading-[0.9]">Host an <span className="text-saffron">event</span></h1>
          <p className="mt-3 text-ink-2">Put the screen on a TV or projector. Everyone joins from their phone with the code, and the screen shows who is making the most profit, live.</p>
        </header>
        {!signedIn ? (
          <div className="flex flex-col gap-3 rounded-lg bg-night-2 p-5"><p className="text-ink-2">Pick a host name first.</p><TraderName onJoined={onJoined} action="Continue" /></div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-5 rounded-lg bg-night-2 p-5" aria-labelledby="event-title">
            <h2 id="event-title" className="panel-title">Your event</h2>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="event-name" className={label}>Event name</label>
              <input id="event-name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finance society night" className={field} />
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className={`${label} mb-1.5`}>Starting amount</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PURSES.map((v) => (
                  <label key={v} className={chip(purse === v)}>
                    <input type="radio" name="purse" checked={purse === v} onChange={() => setPurse(v)} className="sr-only" />
                    {moneyWhole(v * 100)}
                  </label>
                ))}
              </div>
              <label htmlFor="event-purse" className="mt-1 text-[13px] text-ink-3">Or any amount from €1,000 to €1,000,000</label>
              <input id="event-purse" type="number" min={1000} max={1_000_000} step={500} required value={purse} onChange={(e) => setPurse(Number(e.target.value))} className={field} />
            </fieldset>
            <fieldset className="flex flex-col gap-1.5">
              <legend className={`${label} mb-1.5`}>Trading time</legend>
              <div className="grid grid-cols-5 gap-2">
                {MINUTES.map((v) => (
                  <label key={v} className={chip(minutes === v)}>
                    <input type="radio" name="minutes" checked={minutes === v} onChange={() => setMinutes(v)} className="sr-only" />
                    {v} min
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="event-max" className={label}>Most players</label>
              <input id="event-max" type="number" min={2} max={1000} required value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} className={field} />
            </div>
            <label htmlFor="event-late" className="flex items-start gap-3">
              <input id="event-late" type="checkbox" checked={lateJoin} onChange={(e) => setLateJoin(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-saffron)]" />
              <span className="text-[15px]">Let people join after the bell</span>
            </label>
            <p className={`text-sm ${error ? 'text-down' : 'text-ink-3'}`} role={error ? 'alert' : undefined}>
              {error ?? `Everyone starts with ${moneyWhole(purse * 100)} of virtual money. You ring the bell from the screen when the room is in. Prices are simulated.`}
            </p>
            <button type="submit" disabled={busy || !name.trim()} className="h-14 rounded-md bg-saffron text-lg font-bold text-night hover:brightness-110 disabled:opacity-40">
              {busy ? 'Opening' : 'Open the event screen'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- /event/CODE: the TV

export function EventTV({ code, offset }: { code: string; offset: number }) {
  const [view, setView] = useState<EventScreen | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const now = useNow(offset, 500);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(`/api/rooms/${code}/screen`);
        if (r.ok) setView((await r.json()) as EventScreen);
        // A finished room leaves the server after its results: keep the last picture on screen.
        else if (r.status === 404 || r.status === 403) setGone((await r.json().catch(() => ({ error: '' }))).error || 'This event is over');
      } catch {
        /* a blip: the next poll catches up */
      }
      if (!stop) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [code]);

  if (!view) {
    return <div className="grid min-h-dvh place-items-center px-6 text-center text-xl text-ink-2">{gone ?? 'Opening the event screen'}</div>;
  }
  const s = view.session;
  const joinUrl = `${location.origin}/room/${code}`;
  const ended = !!gone || s.phase === 'results';
  const left = s.phase === 'lobby' ? (s.room?.settings.manualStart ? null : s.opensAt - now) : s.closesAt - now;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-6 border-b border-rule bg-night-2 px-6 py-3 lg:px-10">
        <Wordmark />
        <h1 className="min-w-0 flex-1 truncate font-display text-[clamp(1.5rem,2.6vw,2.6rem)] font-black uppercase leading-none">{s.room?.name ?? 'Event'}</h1>
        {view.host && !ended && <HostButtons code={code} phase={s.phase} players={s.players} />}
        <div className="text-right">
          <p className="panel-title">{ended ? 'Final' : s.phase === 'lobby' ? 'Bell in' : s.phase === 'closing' ? 'Last calls' : 'Closes in'}</p>
          <p className={`font-display text-[clamp(2rem,3.4vw,3.4rem)] font-black leading-none ${s.phase === 'closing' ? 'text-down' : 'text-ink'}`} aria-live="off">
            {ended ? 'Closed' : left === null ? 'Soon' : clock(Math.max(0, left))}
          </p>
        </div>
      </header>

      {s.phase === 'lobby' ? (
        <Lobby view={view} code={code} joinUrl={joinUrl} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col gap-4 p-6 lg:p-8" aria-label="Profit race">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-display text-[clamp(1.4rem,2vw,2.2rem)] font-black uppercase">{ended ? 'How it was won' : 'Profit race'}</h2>
              <p className="text-[clamp(0.9rem,1.1vw,1.2rem)] text-ink-2">Top {view.lines.length} traders, profit since the bell</p>
            </div>
            <div className="min-h-0 flex-1"><ProfitChart view={view} /></div>
            <Stats view={view} />
          </section>
          <aside className="flex min-h-0 flex-col border-l border-rule bg-night-2 p-6 lg:p-8" aria-label="Leaderboard">
            <h2 className="mb-3 font-display text-[clamp(1.4rem,2vw,2.2rem)] font-black uppercase">{ended ? 'Final standings' : 'Most profit'}</h2>
            <Board view={view} />
            {!ended && (
              <div className="mt-auto flex items-center gap-4 pt-4">
                <div className="rounded-md bg-ink p-2"><QRCodeSVG value={joinUrl} size={88} bgColor="#f1eadb" fgColor="#0d0b19" level="M" marginSize={0} title={`Join at ${joinUrl}`} /></div>
                <p className="text-[clamp(0.9rem,1.1vw,1.25rem)] text-ink-2">
                  {s.room?.settings.lateJoin ? 'Still time to join: ' : 'Code '}
                  <span className="font-mono font-bold tracking-[0.15em] text-ink">{code}</span>
                </p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function HostButtons({ code, phase, players }: { code: string; phase: string; players: number }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (what: 'start' | 'close') => {
    setBusy(true);
    setError(null);
    const r = await post(`/api/rooms/${code}/${what}`).catch(() => ({ ok: false, body: { error: 'Not reachable' } }));
    if (!r.ok) setError(r.body.error ?? 'That did not work');
    setBusy(false);
    setConfirm(false);
  };
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-sm text-down" role="alert">{error}</span>}
      {phase === 'lobby' ? (
        <button type="button" disabled={busy || players < 1} onClick={() => void act('start')} className="h-12 rounded-md bg-saffron px-5 text-lg font-bold text-night hover:brightness-110 disabled:opacity-40">
          Ring the bell
        </button>
      ) : confirm ? (
        <>
          <button type="button" disabled={busy} onClick={() => void act('close')} className="h-12 rounded-md bg-down px-4 font-bold text-night">Close now</button>
          <button type="button" onClick={() => setConfirm(false)} className="h-12 px-3 font-semibold text-ink-2">Keep trading</button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirm(true)} className="h-12 rounded-md border border-rule px-4 font-semibold text-ink-2 hover:border-down/60 hover:text-down">Close market</button>
      )}
    </div>
  );
}

function Lobby({ view, code, joinUrl }: { view: EventScreen; code: string; joinUrl: string }) {
  const s = view.session;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
      <section className="flex flex-col items-center justify-center gap-6 p-8 text-center" aria-label="Join">
        <h2 className="font-display text-[clamp(2.5rem,5vw,5rem)] font-black uppercase leading-[0.9]">Scan to <span className="text-saffron">join</span></h2>
        <div className="rounded-lg bg-ink p-5 shadow-[0_18px_40px_rgba(0,0,0,0.45)]">
          <QRCodeSVG value={joinUrl} size={360} bgColor="#f1eadb" fgColor="#0d0b19" level="M" marginSize={0} title={`Join at ${joinUrl}`} className="h-auto w-[min(60vw,38vh,360px)]" />
        </div>
        <p className="font-display text-[clamp(1.4rem,2.6vw,2.4rem)] font-bold">{joinUrl.replace(/^https?:\/\//, '').replace(/\/room\/.*/, '')}/room/<span className="text-saffron">{code}</span></p>
        <p className="max-w-md text-[clamp(1rem,1.3vw,1.3rem)] text-ink-2">Everyone starts with {moneyWhole(s.startingCash)} of virtual money. Most profit at the close wins.</p>
      </section>
      <section className="flex min-h-0 flex-col gap-4 bg-night-2 p-8" aria-label="Who is in">
        <p className="font-display text-[clamp(4rem,9vw,9rem)] font-black leading-none text-saffron" aria-live="polite">{view.count}</p>
        <p className="panel-title text-[clamp(1rem,1.4vw,1.4rem)]">{view.count === 1 ? 'trader in' : 'traders in'} (room for {s.maxPlayers})</p>
        <ul className="flex min-h-0 flex-wrap content-start gap-2 overflow-hidden">
          <AnimatePresence initial={false}>
            {view.newest.map((n) => (
              <motion.li key={n} layout="position" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-2 rounded-full bg-night-3 py-1.5 pl-1.5 pr-4 text-[clamp(1rem,1.3vw,1.4rem)] font-semibold">
                <Lattice nickname={n} size={28} />{n}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </section>
    </div>
  );
}

function Board({ view }: { view: EventScreen }) {
  const start = view.session.startingCash;
  if (!view.top.length) return <p className="text-ink-2">Nobody has joined.</p>;
  return (
    <ol className="flex min-h-0 flex-col overflow-hidden">
      <AnimatePresence initial={false}>
        {view.top.map((r) => {
          const line = view.lines.findIndex((l) => l.participantId === r.participantId);
          return (
            <motion.li
              key={r.participantId}
              layout="position"
              transition={{ type: 'spring', stiffness: 400, damping: 38 }}
              className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto_5.5rem] items-center gap-3 border-b border-rule/60 py-[clamp(0.25rem,0.7vh,0.6rem)] text-[clamp(1rem,1.35vw,1.6rem)] ${r.rank === 1 ? 'rounded-md border-transparent bg-saffron-deep px-2' : ''}`}
            >
              <span className={`font-display text-[1.4em] font-black leading-none ${r.rank === 1 ? 'text-saffron' : r.rank <= 3 ? 'text-ink' : 'text-ink-3'}`}>{r.rank}</span>
              <span className="flex min-w-0 items-center gap-2 font-semibold">
                {line >= 0 && <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: LINE_COLORS[line] }} aria-hidden />}
                <Lattice nickname={r.nickname} size={26} you={r.rank === 1} />
                <span className="truncate">{r.nickname}</span>
              </span>
              <span className={`text-right font-bold ${tone(r.value - start)}`}>{signedWhole(r.value - start)}</span>
              <span className={`text-right text-[0.8em] ${tone(r.bps)}`}>{pct(r.bps)}</span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}

function Stats({ view }: { view: EventScreen }) {
  const cells: [string, React.ReactNode][] = [
    ['Traders', view.count],
    ['In profit', <span className="text-up">{view.up}</span>],
    ['In the red', <span className="text-down">{view.down}</span>],
    ['Average return', <span className={tone(view.avgBps)}>{pct(view.avgBps)}</span>],
  ];
  return (
    <dl className="grid shrink-0 grid-cols-4 gap-3">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-night-2 px-4 py-3">
          <dt className="panel-title">{k}</dt>
          <dd className="font-display text-[clamp(1.6rem,2.6vw,3rem)] font-black leading-tight">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Profit (value minus the purse) of the leaders across the whole trading window, so the lines grow towards the close. */
function ProfitChart({ view }: { view: EventScreen }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 900, h: 420 });
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(320, e!.contentRect.width), h: Math.max(200, e!.contentRect.height) }));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const { w, h } = size;
  const start = view.session.startingCash;
  const end = Math.max(1, view.session.totalTicks);
  const pad = { l: 96, r: 210, t: 20, b: 34 };
  const profits = view.lines.flatMap((l) => l.points.map(([, v]) => v - start));
  const lo = Math.min(0, ...profits);
  const hi = Math.max(0, ...profits);
  const span = hi - lo || start * 0.02;
  const x = (t: number) => pad.l + ((w - pad.l - pad.r) * Math.min(t, end)) / end;
  const y = (p: number) => pad.t + ((h - pad.t - pad.b) * (hi + span * 0.08 - p)) / (span * 1.16);
  // Even always; the rest only where they keep clear of a label already drawn.
  const grid = [lo, lo / 2, hi / 2, hi].reduce((kept, v) => (kept.every((k) => Math.abs(y(k) - y(v)) >= 28) ? [...kept, v] : kept), [0]);
  const closing = Math.round((view.session.closesAt - view.session.closingAt) / view.session.tickMs);

  // Names at the line ends, pushed apart so none overlap.
  const ends = view.lines
    .map((l, i) => ({ l, i, p: l.points.at(-1)!, ly: y(l.points.at(-1)![1] - start) }))
    .sort((a, b) => a.ly - b.ly);
  for (let k = 1; k < ends.length; k++) ends[k]!.ly = Math.max(ends[k]!.ly, ends[k - 1]!.ly + 26);

  const leader = view.lines[0];
  return (
    <div ref={setBox} className="h-full w-full rounded-lg bg-night-2">
      <svg width={w} height={h} className="block" role="img" aria-label={leader ? `Profit race. ${leader.nickname} leads.` : 'Profit race'}>
        <defs>
          <linearGradient id="lead-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--color-saffron)" stopOpacity={0.28} />
            <stop offset="1" stopColor="var(--color-saffron)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <rect x={x(end - closing)} y={pad.t} width={x(end) - x(end - closing)} height={h - pad.t - pad.b} fill="var(--color-down-deep)" opacity={0.5} />
        {grid.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--color-ink-3)' : 'var(--color-rule)'} strokeDasharray={v === 0 ? '6 6' : undefined} />
            <text x={pad.l - 10} y={y(v) + 5} fontSize={15} textAnchor="end" fill="var(--color-ink-3)">{v === 0 ? 'Even' : signedWhole(Math.round(v))}</text>
          </g>
        ))}
        <text x={pad.l} y={h - 10} fontSize={15} fill="var(--color-ink-3)">Bell</text>
        <text x={x(end)} y={h - 10} fontSize={15} textAnchor="end" fill="var(--color-ink-3)">Close {clock(end * view.session.tickMs)}</text>
        {leader && leader.points.length > 1 && (
          <path
            d={`M${x(0)},${y(0)}` + leader.points.map(([t, v]) => `L${x(t).toFixed(1)},${y(v - start).toFixed(1)}`).join('') + `L${x(leader.points.at(-1)![0]).toFixed(1)},${y(0)}Z`}
            fill="url(#lead-fill)"
          />
        )}
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          {view.lines.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => (
            <path key={l.participantId} d={l.points.map(([t, v], k) => `${k ? 'L' : 'M'}${x(t).toFixed(1)},${y(v - start).toFixed(1)}`).join('')} stroke={LINE_COLORS[i]} strokeWidth={i === 0 ? 4 : 2.5} opacity={i === 0 ? 1 : 0.85} />
          ))}
        </g>
        {ends.map(({ l, i, p, ly }) => (
          <g key={l.participantId}>
            <circle cx={x(p[0])} cy={y(p[1] - start)} r={i === 0 ? 7 : 5} fill={LINE_COLORS[i]} stroke="var(--color-night-2)" strokeWidth={2} />
            <text x={x(p[0]) + 14} y={ly + 6} fontSize={17} fontWeight={700} fill={LINE_COLORS[i]}>
              {l.nickname.length > 12 ? `${l.nickname.slice(0, 11)}…` : l.nickname}
              <tspan dx={8} fill="var(--color-ink-2)" fontWeight={600}>{signedWhole(p[1] - start)}</tspan>
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
