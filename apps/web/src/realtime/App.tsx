import { useEffect, useState } from 'react';
import { ClaimName, TraderName } from '../components/ceremony';
import { HistoryPage, Leaderboard, Markets, Orders, Overview, Player, PortfolioPage, Settings, Stock, Stocks, Watchlist } from './pages';
import { connect, loadNotes, loadStatus, loadWatch, useRoute } from './store';
import { Shell } from './ui';

/** Haggle RealTime, mounted at /realtime. Shares the account cookie with the classic game and nothing else. */
export function RealtimeApp({ user, onAuth }: { user: { nickname: string; registered: boolean } | null; onAuth: () => void }) {
  // RealTime plays only under a claimed name: a nickname without a password can browse, not trade.
  const nickname = user?.registered ? user.nickname : null;
  const route = useRoute();
  const [down, setDown] = useState<string | null>(null);
  useEffect(() => {
    const status = () => loadStatus().then(() => setDown(null), (e: Error) => setDown(e.message));
    void status();
    connect();
    if (nickname) {
      void loadWatch();
      void loadNotes();
    }
    // Exchange states turn over on the minute; the countdowns tick locally in between.
    const t = setInterval(status, 30_000);
    return () => clearInterval(t);
  }, [nickname]);

  if (down) {
    return (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <p className="text-lg">{down}</p>
          <a href="/" className="rounded-md bg-saffron px-5 py-2.5 font-bold text-night">Back to Haggle</a>
        </div>
      </div>
    );
  }
  const [page, arg] = route;
  const signedIn = !!nickname;
  let body: React.ReactNode;
  if (page === 'markets') body = <Markets />;
  else if (page === 'stocks') body = <Stocks />;
  else if (page === 'stock' && Number(arg) > 0) body = <Stock key={arg} id={Number(arg)} signedIn={signedIn} />;
  else if (page === 'player' && arg) body = <Player key={arg} id={arg} />;
  else if (page === 'leaderboard') body = <Leaderboard signedIn={signedIn} />;
  else if (!signedIn && (page || !user)) body = <SignIn user={user} onAuth={onAuth} />;
  else if (page === 'watchlist') body = <Watchlist />;
  else if (page === 'portfolio') body = <PortfolioPage />;
  else if (page === 'orders') body = <Orders />;
  else if (page === 'history') body = <HistoryPage />;
  else if (page === 'settings') body = <Settings />;
  else body = <Overview signedIn={signedIn} />;
  return <Shell nickname={nickname}>{!signedIn && !page && user && <SignIn user={user} onAuth={onAuth} />}{body}</Shell>;
}

/** Log in or register for RealTime; a nickname-only player sets a password on the name they already have. */
function SignIn({ user, onAuth }: { user: { nickname: string } | null; onAuth: () => void }) {
  return (
    <section className="mx-auto mb-4 flex max-w-xl flex-col gap-3 rounded-lg border border-rule bg-night-2 p-5">
      <h1 className="font-display text-2xl font-black uppercase">{user ? `Claim ${user.nickname}` : 'Sign in to RealTime'}</h1>
      <p className="text-sm text-ink-2">
        {user
          ? 'RealTime portfolios run for weeks, so they live under a name with a password. Set one to start trading; it also lets you log in on other devices.'
          : 'Pick a trader name, or log in with your name and password. A new name needs a password before it can trade.'}
      </p>
      {user ? <ClaimName registered={false} onDone={onAuth} /> : <TraderName onJoined={onAuth} action="Continue" />}
    </section>
  );
}
