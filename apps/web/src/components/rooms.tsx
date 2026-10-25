import { Check, ChevronRight, Copy, Trophy, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clock, money, moneyWhole, pct, SECTOR_COLOR, tone, when } from '../lib/format';
import { useGame, type FullBoard, type HoldingResult, type PortfolioView, type RoomListing, type SessionInfo } from '../lib/game';
import { Pnl, SimulatedChip, useNow, Wordmark } from './chrome';

const field = 'h-11 w-full rounded-md border border-rule bg-night-2 px-3 text-[15px] focus:border-saffron/70 focus:outline-none';
const label = 'text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2';

async function post<T>(path: string, body?: unknown): Promise<{ ok: boolean; body: T & { error?: string } }> {
  const r = await fetch(path, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

// ---------------------------------------------------------------- rooms page

function CreateRoom() {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [minutes, setMinutes] = useState(10);
  const [purse, setPurse] = useState(10_000);
  const [maxPlayers, setMaxPlayers] = useState(30);
  const [start, setStart] = useState<'host' | 'time'>('host');
  const [startAt, setStartAt] = useState('');
  const [description, setDescription] = useState('');
  const [lateJoin, setLateJoin] = useState(true);
  const [peek, setPeek] = useState(false);
  const [reveal, setReveal] = useState(true);
  const [publicResults, setPublicResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ code: string }>('/api/rooms', {
        name, description: description || undefined, visibility, durationMinutes: minutes, startingCash: purse, maxPlayers,
        startAt: start === 'time' && startAt ? new Date(startAt).getTime() : undefined, lateJoin, peek, reveal, publicResults,
      });
      if (!r.ok) throw new Error(r.body.error ?? 'The room was not created. Try again.');
      location.assign(`/room/${r.body.code}`);
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : 'Haggle is not reachable right now.');
      setBusy(false);
    }
  };

  const check = (id: string, text: string, value: boolean, set: (v: boolean) => void, hint?: string) => (
    <label htmlFor={id} className="flex items-start gap-3 py-1.5">
      <input id={id} type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-saffron)]" />
      <span className="text-[14px]">
        {text}
        {hint && <span className="block text-[12px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg bg-night-2 p-5" aria-labelledby="create-title">
      <h2 id="create-title" className="panel-title">Open a room</h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="room-name" className={label}>Room name</label>
        <input id="room-name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friday desk" className={field} />
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className={`${label} mb-1.5`}>Who can join</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['public', 'private'] as const).map((v) => (
            <label key={v} className={`flex h-11 cursor-pointer items-center justify-center rounded-md border text-[14px] font-semibold ${visibility === v ? 'border-saffron bg-saffron-deep text-saffron' : 'border-rule text-ink-2'}`}>
              <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="sr-only" />
              {v === 'public' ? 'Anyone (listed)' : 'Invite code only'}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="room-minutes" className={label}>Trading minutes</label>
          <input id="room-minutes" type="number" min={2} max={120} required value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={field} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="room-start" className={label}>Bell</label>
          <select id="room-start" value={start} onChange={(e) => setStart(e.target.value as 'host' | 'time')} className={field}>
            <option value="host">When I start it</option>
            <option value="time">At a set time</option>
          </select>
        </div>
      </div>
      {start === 'time' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="room-at" className={label}>Bell time</label>
          <input id="room-at" type="datetime-local" required value={startAt} onChange={(e) => setStartAt(e.target.value)} className={field} />
        </div>
      )}
      <details className="group rounded-md border border-rule">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-[14px] font-semibold text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronRight size={15} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
          More rules
        </summary>
        <div className="flex flex-col gap-3 border-t border-rule px-3 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="room-purse" className={label}>Starting purse (EUR)</label>
              <input id="room-purse" type="number" min={1000} max={1_000_000} step={1000} required value={purse} onChange={(e) => setPurse(Number(e.target.value))} className={field} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="room-max" className={label}>Most traders</label>
              <input id="room-max" type="number" min={2} max={500} required value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} className={field} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="room-desc" className={label}>Description</label>
            <input id="room-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className={field} />
          </div>
          <div>
            {check('room-late', 'Let people join after the bell', lateJoin, setLateJoin)}
            {check('room-peek', 'Traders can open each other’s portfolios while trading', peek, setPeek)}
            {check('room-reveal', 'Show every portfolio on the results page', reveal, setReveal, 'Off: each trader sees only their own holdings.')}
            {visibility === 'private' && check('room-public', 'Anyone with the results link can see the standings', publicResults, setPublicResults, 'Off: only traders in this room.')}
          </div>
        </div>
      </details>
      <p className={`text-sm ${error ? 'text-down' : 'text-ink-3'}`} role={error ? 'alert' : undefined}>
        {error ?? `Same market and news as everyone else, your own leaderboard. Everyone starts with ${moneyWhole(purse * 100)}.`}
      </p>
      <button type="submit" disabled={busy || !name.trim()} className="h-12 rounded-md bg-saffron text-[16px] font-bold text-night hover:brightness-110 disabled:opacity-40">
        {busy ? 'Opening' : 'Open the room'}
      </button>
    </form>
  );
}

function JoinByCode() {
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        location.assign(`/room/${clean}`);
      }}
      className="flex flex-col gap-1.5"
    >
      <label htmlFor="join-code" className={label}>Have an invite code?</label>
      <div className="flex gap-2">
        <input id="join-code" value={clean} onChange={(e) => setCode(e.target.value)} placeholder="8 letters" autoComplete="off" className={`${field} font-mono uppercase tracking-[0.2em]`} />
        <button type="submit" disabled={clean.length !== 8} className="h-11 shrink-0 rounded-md border border-rule px-4 font-semibold hover:border-saffron/60 disabled:opacity-40">Join</button>
      </div>
    </form>
  );
}

export function RoomsPage({ signedIn }: { signedIn: boolean }) {
  const [rooms, setRooms] = useState<RoomListing[] | null>(null);
  const t = useNow(0, 1000);
  useEffect(() => {
    const load = () => fetch('/api/rooms').then((r) => r.json() as Promise<{ rooms: RoomListing[] }>).then((d) => setRooms(d.rooms)).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <main className="min-h-dvh bg-night">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <a href="/" aria-label="Haggle home"><Wordmark className="text-4xl" /></a>
          <SimulatedChip />
        </header>
        <div>
          <h1 className="font-display text-[clamp(2.5rem,8vw,4.5rem)] font-black uppercase leading-[0.9]">Rooms</h1>
          <p className="mt-2 max-w-xl text-ink-2">Your own competition on the shared market: your rules, your roster, your results.</p>
        </div>
        <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
          <section aria-labelledby="open-rooms" className="flex min-w-0 flex-col gap-4">
            <JoinByCode />
            <h2 id="open-rooms" className="panel-title">Open rooms</h2>
            {rooms === null ? (
              <p className="text-ink-3" role="status">Loading rooms</p>
            ) : rooms.length === 0 ? (
              <p className="rounded-lg bg-night-2 p-5 text-ink-2">No public rooms right now. Open one, or join the main market.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-rule/60 rounded-lg bg-night-2">
                {rooms.map((r) => (
                  <li key={r.code}>
                    <a href={`/room/${r.code}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 hover:bg-night-3">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{r.name}</span>
                        <span className="block text-[13px] text-ink-3">
                          {r.host ? `${r.host} · ` : ''}{moneyWhole(r.startingCash)} purse · {Math.round((r.closesAt - r.opensAt) / 60_000)} min
                        </span>
                      </span>
                      <span className="text-right text-[13px]">
                        <span className="block font-semibold">{r.players}/{r.maxPlayers}</span>
                        <span className={r.phase === 'lobby' ? 'text-ink-3' : 'text-up'}>
                          {r.phase === 'lobby' ? (r.manualStart ? 'Waiting for host' : `Bell in ${clock(r.opensAt - t)}`) : 'Trading'}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <a href="/" className="text-[14px] font-semibold text-ink-2 underline decoration-ink-3 underline-offset-4 hover:text-ink">Back to the main market</a>
          </section>
          {signedIn ? <CreateRoom /> : (
            <p className="rounded-lg bg-night-2 p-5 text-ink-2"><a href="/" className="font-semibold text-saffron underline underline-offset-4">Pick a trader name</a> to open a room.</p>
          )}
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- in a room

export function CopyInvite({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the code is on screen to read out */
    }
  };
  return (
    <button type="button" onClick={() => void copy()} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rule px-2.5 text-[13px] font-semibold hover:border-saffron/60" aria-label={`Copy invite link for room ${code}`}>
      <span className="font-mono tracking-[0.15em]">{code}</span>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span className="sr-only" role="status">{copied ? 'Link copied' : ''}</span>
    </button>
  );
}

/** Host buttons: ring the bell now, or close the market early. Only rendered for the host. */
export function HostControls({ session }: { session: SessionInfo }) {
  const you = useGame((s) => s.you?.userId);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const room = session.room;
  if (!room || room.hostId !== you || session.phase === 'results') return null;
  const act = async (what: 'start' | 'close') => {
    setBusy(true);
    setError(null);
    const r = await post(`/api/rooms/${room.code}/${what}`).catch(() => ({ ok: false, body: { error: 'Not reachable' } }));
    if (!r.ok) setError(r.body.error ?? 'That did not work');
    setBusy(false);
    setConfirm(false);
  };
  if (session.phase === 'lobby') {
    return (
      <span className="inline-flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void act('start')} className="h-8 rounded-md bg-saffron px-3 text-[13px] font-bold text-night hover:brightness-110 disabled:opacity-40">
          Ring the bell now
        </button>
        {error && <span className="text-[12px] text-down" role="alert">{error}</span>}
      </span>
    );
  }
  return confirm ? (
    <span className="inline-flex items-center gap-2 text-[13px]" role="group" aria-label="Confirm closing the market">
      <span className="text-ink-2">Close at the current prices?</span>
      <button type="button" disabled={busy} onClick={() => void act('close')} className="h-8 rounded-md bg-down px-3 font-bold text-night">Close</button>
      <button type="button" onClick={() => setConfirm(false)} className="h-8 px-2 font-semibold text-ink-2">Keep trading</button>
    </span>
  ) : (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => setConfirm(true)} className="h-8 rounded-md border border-rule px-3 text-[13px] font-semibold text-ink-2 hover:border-down/60 hover:text-down">
        Close market
      </button>
      {error && <span className="text-[12px] text-down" role="alert">{error}</span>}
    </span>
  );
}

/** A slim strip under the top bar: which room this is, its invite code and the host's controls. */
export function RoomBar() {
  const session = useGame((s) => s.session);
  const room = session?.room;
  if (!session || !room) return null;
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rule bg-night-2 px-3 py-1 sm:px-4">
      <span className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="truncate font-semibold">{room.name}</span>
        <span className="hidden text-ink-3 sm:inline">{room.visibility === 'private' ? 'private room' : 'public room'}{room.host ? `, hosted by ${room.host}` : ''}</span>
      </span>
      <span className="flex items-center gap-2">
        <HostControls session={session} />
        <CopyInvite code={room.code} />
        <a href="/rooms" className="text-[13px] font-semibold text-ink-3 hover:text-ink">All rooms</a>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- portfolios

/** Every position at a given price: shares, average cost, cost basis, value, realised and unrealised P/L. */
export function PortfolioTable({ holdings, cash, start }: { holdings: HoldingResult[]; cash: number; start: number }) {
  const assets = useGame((s) => s.assets);
  const index = useGame((s) => s.index);
  const value = cash + holdings.reduce((sum, h) => sum + h.qty * h.close, 0);
  if (!holdings.length) return <p className="text-[13px] text-ink-3">All cash: {money(cash)}, no positions.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-[13px]">
        <caption className="sr-only">Positions valued at the competition’s prices</caption>
        <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
          <tr>
            <th scope="col" className="px-2 py-1.5 font-medium">Company</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Shares</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Avg cost</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Price</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Cost basis</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Value</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Unrealised</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Realised</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const a = assets[index.get(h.ticker) ?? -1];
            const worth = h.qty * h.close;
            const unrealized = worth - h.cost;
            const total = unrealized + h.realized;
            return (
              <tr key={h.ticker} className="border-t border-rule/60">
                <td className="px-2 py-1.5">
                  <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: SECTOR_COLOR[a?.sector ?? ''] ?? 'var(--color-ink-3)' }} aria-hidden />
                  <span className="font-bold">{h.ticker}</span>
                </td>
                <td className="px-2 py-1.5 text-right">{h.qty || 'sold'}</td>
                <td className="px-2 py-1.5 text-right text-ink-2">{h.qty ? money(Math.round(h.cost / h.qty)) : '–'}</td>
                <td className="px-2 py-1.5 text-right">{money(h.close)}</td>
                <td className="px-2 py-1.5 text-right text-ink-2">{money(h.cost)}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{money(worth)}</td>
                <td className="px-2 py-1.5 text-right">{h.qty ? <><Pnl cents={unrealized} />{h.cost > 0 && <span className={`ml-1 text-[12px] ${tone(unrealized)}`}>{pct(Math.round((unrealized * 10_000) / h.cost))}</span>}</> : '–'}</td>
                <td className="px-2 py-1.5 text-right">{h.realized ? <Pnl cents={h.realized} /> : <span className="text-ink-3">–</span>}</td>
                <td className="px-2 py-1.5 text-right"><Pnl cents={total} /></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t border-rule text-[13px]">
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink-3">Cash {money(cash)}</th>
            <td colSpan={4} />
            <td className="px-2 py-1.5 text-right font-semibold">{money(value)}</td>
            <td colSpan={2} />
            <td className="px-2 py-1.5 text-right"><Pnl cents={value - start} /> <span className={`text-[12px] ${tone(value - start)}`}>{pct(Math.round(((value - start) * 10_000) / start))}</span></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Peek({ sessionId, participantId, start }: { sessionId: string; participantId: string; start: number }) {
  const [view, setView] = useState<PortfolioView | 'error' | null>(null);
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/portfolio/${participantId}`)
      .then((r) => (r.ok ? (r.json() as Promise<PortfolioView>) : Promise.reject(new Error())))
      .then(setView)
      .catch(() => setView('error'));
  }, [sessionId, participantId]);
  if (view === null) return <p className="text-[13px] text-ink-3" role="status">Loading portfolio</p>;
  if (view === 'error') return <p className="text-[13px] text-down">That portfolio did not load.</p>;
  return <PortfolioTable holdings={view.holdings} cash={view.cash} start={start} />;
}

// ---------------------------------------------------------------- full leaderboard

/**
 * Every trader in the competition, valued at one moment by the server. Opens as a dialog over the
 * floor and closes back to it, so the order ticket is never covered for long.
 */
export function Leaderboard() {
  const ref = useRef<HTMLDialogElement>(null);
  const session = useGame((s) => s.session);
  const conn = useGame((s) => s.conn);
  const you = useGame((s) => s.board.me?.participantId);
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<FullBoard | null>(null);
  const [failed, setFailed] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  const id = session?.id;
  const load = useCallback(() => {
    if (!id) return;
    fetch(`/api/sessions/${id}/board`)
      .then((r) => (r.ok ? (r.json() as Promise<FullBoard>) : Promise.reject(new Error())))
      .then((b) => {
        setBoard(b);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [id]);
  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [open, load]);
  if (!session) return null;
  const start = session.startingCash;
  const canPeek = !!session.room?.settings.peek && !!you;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          ref.current?.showModal();
        }}
        className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-2 hover:text-saffron"
      >
        <Trophy size={14} aria-hidden /> Full leaderboard
      </button>
      <dialog
        ref={ref}
        onClose={() => {
          setOpen(false);
          setPeek(null);
        }}
        aria-labelledby="board-title"
        className="m-auto max-h-[90dvh] w-[min(64rem,calc(100vw-1rem))] rounded-lg border border-rule bg-night p-0 text-ink backdrop:bg-night/80"
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-rule bg-night px-4 py-3">
          <div>
            <h2 id="board-title" className="panel-title">Leaderboard</h2>
            <p className="text-[12px] text-ink-3" role="status">
              {conn !== 'open' || failed
                ? 'Reconnecting. Ranks are paused at the last update.'
                : board
                  ? `${board.rows.length} traders, valued together at ${when(board.at)}. Ties go to whoever joined first.`
                  : 'Loading'}
            </p>
          </div>
          <form method="dialog">
            <button type="submit" aria-label="Close leaderboard" className="grid h-10 w-10 place-items-center rounded-md hover:bg-night-3"><X size={18} aria-hidden /></button>
          </form>
        </div>
        {board && (
          <div className="overflow-x-auto px-2 pb-3">
            <table className="w-full min-w-[44rem] text-[13px]">
              <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium">#</th>
                  <th scope="col" className="px-2 py-2 font-medium">Trader</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Portfolio</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Cash</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Holdings</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">P/L</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Return</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Trades</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <PeekRow key={r.participantId} open={peek === r.participantId} onToggle={canPeek && r.participantId !== you ? () => setPeek(peek === r.participantId ? null : r.participantId) : undefined}
                    mine={r.participantId === you} cells={[
                      <span className={`font-display text-lg font-extrabold ${r.rank === 1 ? 'text-saffron' : ''}`}>{r.rank}</span>,
                      <span className="font-semibold">{r.nickname}{r.participantId === you && <span className="ml-1.5 text-[11px] uppercase tracking-[0.08em] text-saffron">you</span>}</span>,
                      money(r.value), money(r.cash), money(r.value - r.cash), <Pnl cents={r.value - start} />, <span className={tone(r.bps)}>{pct(r.bps)}</span>, r.trades,
                    ]}>
                    {peek === r.participantId && id && <Peek sessionId={id} participantId={r.participantId} start={start} />}
                  </PeekRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </dialog>
    </>
  );
}

function PeekRow({ cells, mine, open, onToggle, children }: { cells: React.ReactNode[]; mine: boolean; open: boolean; onToggle?: () => void; children: React.ReactNode }) {
  return (
    <>
      <tr className={`border-t border-rule/60 ${mine ? 'bg-saffron-deep' : ''}`}>
        {cells.map((c, i) => (
          <td key={i} className={`px-2 py-1.5 ${i >= 2 ? 'text-right' : ''}`}>
            {i === 1 && onToggle ? (
              <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-1 hover:text-saffron">
                <ChevronRight size={14} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
                {c}
              </button>
            ) : c}
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td colSpan={cells.length} className="bg-night-2 px-3 py-2">{children}</td>
        </tr>
      )}
    </>
  );
}
