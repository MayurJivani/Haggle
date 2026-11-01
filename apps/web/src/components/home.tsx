import { useEffect, useState } from 'react';
import { clock, moneyWhole } from '../lib/format';
import type { SessionInfo } from '../lib/game';
import { AwningRow } from './ceremony';
import { leave, SimulatedChip, useNow, Wordmark } from './chrome';
import { JoinByCode } from './rooms';

function marketStatus(session: SessionInfo | null, t: number) {
  if (!session) return 'The next competition is being set up.';
  if (session.phase === 'lobby') return `Next bell in ${clock(session.opensAt - t)}, ${session.players} waiting.`;
  if (session.phase === 'results') return 'Results are in. The next competition opens shortly.';
  return `Market open, ${clock(session.closesAt - t)} left, ${session.players} trading.`;
}

/** The front door: nothing here joins a competition until the visitor picks one. */
export function Home({ nickname, session: first, offset }: { nickname: string | null; session: SessionInfo | null; offset: number }) {
  const [session, setSession] = useState(first);
  const t = useNow(offset, 1000);
  useEffect(() => {
    const id = setInterval(() => {
      fetch('/api/me')
        .then((r) => r.json() as Promise<{ session: SessionInfo | null }>)
        .then((m) => setSession(m.session))
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, []);
  return (
    <main className="flex min-h-dvh flex-col bg-night">
      <AwningRow className="h-10 sm:h-14" grow />
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-10 px-5 py-10 sm:px-8">
        <div>
          <h1><Wordmark className="block text-[clamp(4rem,16vw,8.5rem)]" /></h1>
          <p className="mt-4 max-w-xl text-lg text-ink-2">A live stock market for the whole room. Same prices, same news, one clock. The fattest purse at the closing bell wins.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <section aria-labelledby="home-main" className="flex flex-col gap-4 rounded-lg bg-night-2 p-5 sm:p-6">
            <h2 id="home-main" className="font-display text-[34px] font-black uppercase leading-none">Main market</h2>
            <p className="text-ink-2">Rounds run all day with whoever turns up: {session ? moneyWhole(session.startingCash) : 'a full purse'} and 75 companies.</p>
            <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-up" aria-hidden />
              {marketStatus(session, t)}
            </p>
            <a href="/play" className="mt-auto grid h-14 place-items-center rounded-md bg-saffron text-lg font-bold text-night hover:brightness-110">Enter the market</a>
          </section>
          <section aria-labelledby="home-custom" className="flex flex-col gap-4 rounded-lg bg-night-2 p-5 sm:p-6">
            <h2 id="home-custom" className="font-display text-[34px] font-black uppercase leading-none">Custom game</h2>
            <p className="text-ink-2">Play with friends on your own rules: the length, the purse and which of 150 companies are on the floor.</p>
            <a href="/rooms" className="grid h-14 place-items-center rounded-md border border-saffron/70 text-lg font-bold text-saffron hover:bg-saffron-deep">Create or find a game</a>
            <JoinByCode />
          </section>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-3">
          <SimulatedChip />
          <span>Virtual money only. Company names are real; every price and headline is simulated.</span>
          {nickname && (
            <span className="ml-auto">
              Trading as <strong className="text-ink">{nickname}</strong>.{' '}
              <button type="button" onClick={() => void leave()} className="underline decoration-ink-3 underline-offset-4 hover:text-ink">Change name</button>
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
