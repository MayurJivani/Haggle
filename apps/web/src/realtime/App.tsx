import { useEffect, useState } from 'react';
import { HistoryPage, Leaderboard, Markets, Orders, Overview, Player, PortfolioPage, Settings, Stock, Stocks, Watchlist } from './pages';
import { connect, loadNotes, loadStatus, loadWatch, useRoute } from './store';
import { Shell } from './ui';

/** Haggle RealTime, mounted at /realtime. Shares the account cookie with the classic game and nothing else. */
export function RealtimeApp({ nickname }: { nickname: string | null }) {
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
  else if (!signedIn && page) body = <p className="py-10 text-center">This page needs a player. <a href="/play" className="text-saffron">Pick a nickname</a> first.</p>;
  else if (page === 'watchlist') body = <Watchlist />;
  else if (page === 'portfolio') body = <PortfolioPage />;
  else if (page === 'orders') body = <Orders />;
  else if (page === 'history') body = <HistoryPage />;
  else if (page === 'settings') body = <Settings />;
  else body = <Overview signedIn={signedIn} />;
  return <Shell nickname={nickname}>{body}</Shell>;
}
