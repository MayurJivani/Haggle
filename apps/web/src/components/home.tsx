import { motion, useReducedMotion } from 'motion/react';
import { ArrowDownRight, ArrowUpRight, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clock, money, moneyWhole, pct, SECTOR_COLOR, tone, when } from '../lib/format';
import type { EventInfo, FloorInfo, RoomListing, SessionInfo } from '../lib/game';
import { AwningRow, ClaimName } from './ceremony';
import { leave, SimulatedChip, useNow, Wordmark } from './chrome';
import { JoinByCode } from './rooms';
import { SourceTag } from './side';

const ease = [0.16, 1, 0.3, 1] as const;
const reveal = { initial: { opacity: 0, y: 18 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, amount: 0.2 }, transition: { duration: 0.7, ease } };

function marketStatus(session: SessionInfo | null, t: number) {
  if (!session) return 'The next competition is being set up.';
  if (session.phase === 'lobby') return `Next bell in ${clock(session.opensAt - t)}, ${session.players} waiting.`;
  if (session.phase === 'results') return 'Results are in. The next competition opens shortly.';
  return `Market open, ${clock(session.closesAt - t)} left, ${session.players} trading.`;
}

function usePolled<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    const load = () => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error()))).then(setData).catch(() => {});
    load();
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [url, ms]);
  return data;
}

/** A price that flashes when it changes, as it does on the floor. */
function Price({ cents }: { cents: number }) {
  const last = useRef(cents);
  const dir = cents > last.current ? 'flash-up' : cents < last.current ? 'flash-down' : '';
  last.current = cents;
  return <span key={cents} className={dir}>{money(cents)}</span>;
}

function Tape({ quotes }: { quotes: FloorInfo['quotes'] }) {
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const still = useReducedMotion();
  const row = (hidden: boolean) => quotes.map((q) => (
    <li key={q.ticker} aria-hidden={hidden || undefined} className="flex shrink-0 items-baseline gap-2 border-r border-rule px-4 text-[13px]">
      <span className="h-2 w-2 self-center rounded-[2px]" style={{ background: SECTOR_COLOR[q.sector] }} aria-hidden />
      <span className="font-bold">{q.ticker}</span>
      <span className="text-ink-2"><Price cents={q.price} /></span>
      <span className={tone(q.bps)}>{pct(q.bps)}</span>
    </li>
  ));
  return (
    <div className="flex h-10 items-center border-b border-rule bg-night-2" role="region" aria-label="Simulated prices on the main market">
      <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {quotes.length > 0 && (
          <ul className={`flex w-max ${still ? '' : 'tape'}`} data-paused={paused || hovered}>
            {row(false)}
            {!still && row(true)}
          </ul>
        )}
      </div>
      {!still && (
        <button type="button" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play the price tape' : 'Pause the price tape'} className="grid h-10 w-10 shrink-0 place-items-center border-l border-rule text-ink-3 hover:text-ink">
          {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
        </button>
      )}
    </div>
  );
}

function Movers({ quotes }: { quotes: FloorInfo['quotes'] }) {
  const sorted = useMemo(() => [...quotes].sort((a, b) => b.bps - a.bps), [quotes]);
  const rows = [...sorted.slice(0, 3), ...sorted.slice(-3)];
  const up = quotes.filter((q) => q.bps > 0).length;
  const avg = quotes.length ? quotes.reduce((t, q) => t + q.bps, 0) / quotes.length : 0;
  return (
    <section aria-labelledby="home-floor" className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-2">
        <h2 id="home-floor" className="panel-title">The floor over the last round</h2>
        <span className={`text-[15px] font-semibold ${tone(avg)}`}>{pct(Math.round(avg))}</span>
      </div>
      {quotes.length === 0 ? (
        <p className="py-6 text-sm text-ink-3" role="status">Reading the tape</p>
      ) : (
        <>
          <motion.ol layout className="divide-y divide-rule/60">
            {rows.map((q) => (
              <motion.li layout key={q.ticker} transition={{ type: 'spring', stiffness: 380, damping: 34 }} className="grid grid-cols-[1.25rem_1fr_auto_4.5rem] items-center gap-2 py-2 text-[14px]">
                {q.bps >= 0 ? <ArrowUpRight size={16} className="text-up" aria-hidden /> : <ArrowDownRight size={16} className="text-down" aria-hidden />}
                <span className="flex items-center gap-2 font-bold"><span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SECTOR_COLOR[q.sector] }} aria-hidden />{q.ticker}</span>
                <span className="text-ink-2"><Price cents={q.price} /></span>
                <span className={`text-right font-semibold ${tone(q.bps)}`}>{pct(q.bps)}</span>
              </motion.li>
            ))}
          </motion.ol>
          <p className="mt-2 text-[13px] text-ink-3">{up} of {quotes.length} companies are up. All simulated prices.</p>
        </>
      )}
    </section>
  );
}

const minutes = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`);

/** The round to scale: the bar's parts are as long as the server really runs them. */
function Round({ round }: { round: FloorInfo['round'] | null }) {
  const r = round ?? { lobby: 120, trading: 600, closing: 45, results: 180 };
  const acts = [
    { name: 'Lobby', len: r.lobby, text: 'Everyone joins and reads the prices. Nothing trades yet.', color: 'var(--color-night-4)' },
    { name: 'The bell', len: r.trading - r.closing, text: 'Everyone gets the same purse. Buy and sell at the live price while news lands on every screen at once.', color: 'var(--color-saffron)' },
    { name: 'Last calls', len: r.closing, text: 'The clock turns red. Hold your nerve or cash out.', color: 'var(--color-down)' },
    { name: 'Results', len: r.results, text: 'Cash plus shares at the closing price decides the roster. Then the market carries on and the next round begins.', color: 'var(--color-ink-3)' },
  ];
  const total = acts.reduce((t, a) => t + a.len, 0);
  return (
    <section aria-labelledby="home-round" className="flex flex-col gap-6">
      <h2 id="home-round" className="font-display text-[clamp(2.25rem,6vw,4rem)] font-black uppercase leading-[0.9]">One clock for everyone</h2>
      <motion.div className="flex h-5 w-full origin-left gap-[2px] overflow-hidden rounded-sm" initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true, amount: 0.6 }} transition={{ duration: 1.2, ease }} aria-hidden>
        {acts.map((a) => <span key={a.name} className="h-full" style={{ width: `${(a.len / total) * 100}%`, background: a.color }} />)}
      </motion.div>
      <ol className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        {acts.map((a, i) => (
          <motion.li key={a.name} {...reveal} transition={{ ...reveal.transition, delay: i * 0.08 }}>
            <h3 className="flex items-baseline justify-between gap-2 font-display text-[22px] font-extrabold uppercase leading-none">
              {a.name}<span className="font-sans text-[13px] font-semibold normal-case text-ink-3">{minutes(a.len)}</span>
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{a.text}</p>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}

const SOURCES: { id: NonNullable<EventInfo['source']>; text: string }[] = [
  { id: 'official', text: 'Central banks and government figures. It happened.' },
  { id: 'earnings', text: 'Filed results against what the market expected. Record profit can still disappoint.' },
  { id: 'breaking', text: 'Company news as it breaks.' },
  { id: 'preliminary', text: 'Early, unaudited numbers. The full report comes later.' },
  { id: 'analyst', text: 'An opinion, often late, sometimes wrong.' },
  { id: 'rumour', text: 'Nobody has confirmed it. It may come to nothing.' },
];

function Crier({ news }: { news: EventInfo[] }) {
  return (
    <section aria-labelledby="home-crier" className="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <h2 id="home-crier" className="font-display text-[clamp(2.25rem,6vw,4rem)] font-black uppercase leading-[0.9]">Listen to the crier. Doubt it too.</h2>
        <p className="max-w-xl text-ink-2">News hits every screen in the same second and moves the price on that tick, so a headline is something to weigh, not a free trade. Good news can already be in the price. The stories say what happened and never what to do.</p>
        {news.length > 0 && (
          <ol className="mt-2 divide-y divide-rule/60 border-y border-rule/60">
            {news.map((ev, i) => (
              <motion.li key={ev.id} {...reveal} transition={{ ...reveal.transition, delay: i * 0.06 }} className="py-2.5">
                <span className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                  <SourceTag source={ev.source} />
                  <time dateTime={new Date(ev.at).toISOString()}>{when(ev.at)}</time>
                </span>
                <span className="mt-1 block text-[15px] font-semibold leading-snug">{ev.headline}</span>
              </motion.li>
            ))}
          </ol>
        )}
      </div>
      <dl className="flex flex-col self-start">
        {SOURCES.map((s, i) => (
          <motion.div key={s.id} {...reveal} transition={{ ...reveal.transition, delay: i * 0.06 }} className="grid grid-cols-[6.5rem_1fr] items-baseline gap-3 border-b border-rule/60 py-3 first:pt-0">
            <dt><SourceTag source={s.id} /></dt>
            <dd className="text-[14px] text-ink-2">{s.text}</dd>
          </motion.div>
        ))}
      </dl>
    </section>
  );
}

/** The rows of stalls: a tall awning for each sector, dropping in one after another. */
function Stalls({ quotes }: { quotes: FloorInfo['quotes'] }) {
  const sectors = useMemo(() => [...new Set(quotes.map((q) => q.sector))].map((name) => {
    const members = quotes.filter((q) => q.sector === name);
    return { name, tickers: members.map((q) => q.ticker), bps: Math.round(members.reduce((t, q) => t + q.bps, 0) / members.length) };
  }), [quotes]);
  if (!sectors.length) return null;
  return (
    <section aria-labelledby="home-stalls" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <h2 id="home-stalls" className="font-display text-[clamp(2.25rem,6vw,4rem)] font-black uppercase leading-[0.9]">Fifteen rows of stalls</h2>
        <p className="max-w-md text-ink-2">Dear oil lifts producers and grounds airlines. A chip shortage lifts chipmakers and stalls carmakers. Learn who moves with whom.</p>
      </div>
      <ul className="grid grid-cols-2 gap-x-px gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {sectors.map((s, i) => (
          <motion.li key={s.name} style={{ ['--stripe' as string]: SECTOR_COLOR[s.name] }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true, amount: 0.3 }} transition={{ delay: (i % 5) * 0.05 }}>
            <motion.div className="awning h-8 origin-top" initial={{ scaleY: 0 }} whileInView={{ scaleY: 1 }} viewport={{ once: true }} transition={{ duration: 0.7, ease, delay: (i % 5) * 0.05 }} aria-hidden />
            <div className="pr-3 pt-2">
              <h3 className="font-display text-[17px] font-bold uppercase leading-tight tracking-[0.03em]" style={{ color: 'var(--stripe)' }}>{s.name}</h3>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{s.tickers.join(' ')}</p>
              <p className={`mt-1 text-[13px] font-semibold ${tone(s.bps)}`}>{pct(s.bps)}</p>
            </div>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

function Custom({ rooms, t }: { rooms: RoomListing[]; t: number }) {
  const rules: [string, string][] = [
    ['Length', '2 to 120 minutes'],
    ['Purse', '€1,000 to €1,000,000'],
    ['Companies', '5 to 150, your pick'],
    ['Who joins', 'Open, or invite code only'],
    ['Portfolios', 'Open while trading, or kept secret'],
    ['The bell', 'When you ring it, or at a set time'],
  ];
  return (
    <section aria-labelledby="home-friends" className="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-5">
        <h2 id="home-friends" className="font-display text-[clamp(2.25rem,6vw,4rem)] font-black uppercase leading-[0.9]">Your friends, your rules</h2>
        <p className="max-w-xl text-ink-2">The same market and the same news, with your own leaderboard. Only banks? Only ten minutes? Everyone's holdings on show at the end? You decide, and share one code.</p>
        <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {rules.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-rule/60 py-2 text-[14px]">
              <dt className="text-ink-3">{k}</dt>
              <dd className="text-right font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <a href="/rooms" className="grid h-14 place-items-center self-start rounded-md bg-saffron px-8 text-lg font-bold text-night hover:brightness-110">Create a game</a>
      </div>
      <div className="flex flex-col gap-5 self-start">
        <JoinByCode />
        <div>
          <h3 className="panel-title">Open games</h3>
          {rooms.length === 0 ? (
            <p className="mt-2 text-[14px] text-ink-3">None open right now. Yours could be the first.</p>
          ) : (
            <ul className="mt-2 divide-y divide-rule/60 border-y border-rule/60">
              {rooms.slice(0, 4).map((r) => (
                <li key={r.code}>
                  <a href={`/room/${r.code}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 hover:text-saffron">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{r.name}</span>
                      <span className="block text-[13px] text-ink-3">{moneyWhole(r.startingCash)} purse, {r.companies} companies</span>
                    </span>
                    <span className="text-right text-[13px]">
                      <span className="block font-semibold">{r.players}/{r.maxPlayers}</span>
                      <span className={r.phase === 'lobby' ? 'text-ink-3' : 'text-up'}>{r.phase === 'lobby' ? (r.manualStart ? 'Waiting' : `Bell in ${clock(r.opensAt - t)}`) : 'Trading'}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The front door: nothing here joins a competition until the visitor picks one. */
export function Home({ nickname, registered, onAuth, session: first, offset }: { nickname: string | null; registered: boolean; onAuth: () => void; session: SessionInfo | null; offset: number }) {
  const me = usePolled<{ session: SessionInfo | null }>('/api/me', 10_000);
  const floor = usePolled<FloorInfo>('/api/floor', 5000);
  const rooms = usePolled<{ rooms: RoomListing[] }>('/api/rooms', 15_000);
  const session = me ? me.session : first;
  const t = useNow(offset, 1000);
  const quotes = floor?.quotes ?? [];
  return (
    <main className="flex min-h-dvh flex-col bg-night">
      <AwningRow className="h-10 sm:h-14" grow />
      <Tape quotes={quotes} />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-20 px-5 pb-16 pt-10 sm:gap-28 sm:px-8 sm:pt-14">
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-7">
            <h1><Wordmark className="block text-[clamp(4.5rem,15vw,6rem)]" /></h1>
            <p className="max-w-xl text-xl leading-relaxed text-ink-2">A live stock market for the whole room. Same prices, same news, one clock. The fattest purse at the closing bell wins.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <motion.a href="/play" whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }} className="grid h-14 place-items-center rounded-md bg-saffron px-8 text-lg font-bold text-night">Enter the market</motion.a>
              <motion.a href="/rooms" whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }} className="grid h-14 place-items-center rounded-md border border-saffron/70 px-8 text-lg font-bold text-saffron hover:bg-saffron-deep">Play with friends</motion.a>
            </div>
            <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-up motion-reduce:animate-none" aria-hidden />
              {marketStatus(session, t)}
            </p>
            {nickname && (
              <p className="text-sm text-ink-3">
                Trading as <strong className="text-ink">{nickname}</strong>.{' '}
                <button type="button" onClick={() => void leave()} className="underline decoration-ink-3 underline-offset-4 hover:text-ink">{registered ? 'Log out' : 'Change name'}</button>
              </p>
            )}
            {nickname && !registered && (
              <details className="max-w-md text-sm text-ink-3">
                <summary className="cursor-pointer font-semibold text-ink-2 hover:text-ink">Keep this name: set a password</summary>
                <div className="mt-3"><ClaimName registered={false} onDone={onAuth} /></div>
              </details>
            )}
            {!nickname && (
              <a href="/play" className="text-sm font-semibold text-ink-2 underline decoration-ink-3 underline-offset-4 hover:text-ink">Have a password? Log in</a>
            )}
          </div>
          <Movers quotes={quotes} />
        </div>
        <Round round={floor?.round ?? null} />
        <Crier news={floor?.news ?? []} />
        <Stalls quotes={quotes} />
        <Custom rooms={rooms?.rooms ?? []} t={t} />
        <section aria-labelledby="home-realtime" className="flex flex-col items-start gap-3 border-t border-rule pt-8">
          <h2 id="home-realtime" className="flex items-center gap-2 font-display text-2xl font-black uppercase">
            Haggle RealTime
            <span className="rounded-sm bg-saffron-deep px-1.5 py-0.5 font-sans text-[11px] font-bold tracking-[0.08em] text-saffron">BETA</span>
          </h2>
          <p className="max-w-xl text-sm text-ink-2">Paper-trade real stocks at real prices, on the real exchange clock. Virtual cash, real market.</p>
          <a href="/realtime" className="rounded-md border border-saffron/70 px-5 py-2.5 text-sm font-bold text-saffron hover:bg-saffron-deep">Try RealTime</a>
        </section>
        <footer className="flex flex-col gap-3 border-t border-rule pt-6 text-[13px] text-ink-3">
          <SimulatedChip />
          <p className="max-w-3xl">Virtual money only. Company names are real; every price, report and headline is simulated, and none of it is advice. Market orders and whole shares, with no shorting or leverage. Trades never move prices, so nobody can push the market around: you only have the news and your nerve.</p>
        </footer>
      </div>
    </main>
  );
}
