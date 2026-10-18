import { MotionConfig } from 'motion/react';
import { BarChart3, LineChart, Store, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Bell, Join, Lobby, Results, ShareCard, Splash } from './components/ceremony';
import { ConnectionPill, Toasts, TopBar, Tape, useMedia, useNow } from './components/chrome';
import { CompanyPanel, Holdings, OrderPanel, StallList } from './components/floor';
import { Crier, Feed, Roster } from './components/side';
import { clock } from './lib/format';
import { game, useGame, type SessionInfo } from './lib/game';

type Tab = 'market' | 'trade' | 'portfolio' | 'board';
const TABS: { id: Tab; label: string; Icon: typeof Store }[] = [
  { id: 'market', label: 'Stalls', Icon: Store },
  { id: 'trade', label: 'Trade', Icon: LineChart },
  { id: 'portfolio', label: 'Purse', Icon: Wallet },
  { id: 'board', label: 'Roster', Icon: BarChart3 },
];

function LastCalls() {
  const session = useGame((s) => s.session);
  const offset = useGame((s) => s.offset);
  const t = useNow(offset);
  if (session?.phase !== 'closing') return null;
  return (
    <div className="flex h-8 shrink-0 items-center justify-center gap-2 bg-down-deep text-[13px] font-semibold text-down" role="status">
      <span className="h-2 w-2 animate-pulse rounded-full bg-down" aria-hidden />
      Last calls: the market closes in {clock(session.closesAt - t)}<span className="hidden sm:inline">. Every purse is valued at the closing prices</span>.
    </div>
  );
}

function Terminal() {
  const assets = useGame((s) => s.assets);
  const spectating = useGame((s) => s.spectating);
  const [ticker, setTicker] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('market');
  const selected = ticker ?? assets[0]?.ticker ?? '';
  const pick = useCallback((t: string) => {
    setTicker(t);
    setTab('trade');
  }, []);

  // Roster and news render once: under the trade area on tablets, in their own column otherwise.
  const tablet = useMedia('(min-width: 768px) and (max-width: 1279px)');
  const show = (t: Tab) => (tab === t ? 'flex' : 'hidden');
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <Tape onPick={pick} />
      <LastCalls />
      {spectating === 'full' && (
        <p className="shrink-0 bg-saffron-deep px-4 py-1.5 text-center text-[13px] text-saffron" role="status">
          This session is full, so you are watching. You will be dealt into the next one.
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <Crier onSelect={pick} />
        <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_340px]">
          <aside aria-label="Stalls" className={`${show('market')} min-h-0 flex-col border-rule bg-night-2 md:flex md:border-r`}>
            <StallList selected={selected} onSelect={pick} />
          </aside>

          <main className={`${tab === 'trade' || tab === 'portfolio' ? 'flex' : 'hidden'} min-h-0 flex-col overflow-y-auto md:flex`}>
            <div className={`${show('trade')} flex-col md:flex lg:min-h-[420px] lg:flex-1 lg:flex-row`}>
              <div className="flex min-w-0 flex-1 flex-col md:min-h-[380px]">{selected && <CompanyPanel ticker={selected} />}</div>
              <div className="border-rule lg:w-[300px] lg:shrink-0 lg:border-l">{selected && <OrderPanel ticker={selected} />}</div>
            </div>
            <div className={`${show('portfolio')} flex-col border-rule md:flex md:border-t`}>
              <Holdings onSelect={pick} />
            </div>
            {tablet && (
              <div className="grid grid-cols-2 border-t border-rule">
                <Roster />
                <div className="border-l border-rule">
                  <Feed onSelect={pick} />
                </div>
              </div>
            )}
          </main>

          {!tablet && (
            <aside aria-label="Roster and news" className={`${show('board')} min-h-0 flex-col overflow-y-auto border-rule bg-night-2 md:hidden xl:flex xl:border-l`}>
              <Roster />
              <div className="border-t border-rule">
                <Feed onSelect={pick} />
              </div>
            </aside>
          )}
        </div>
      </div>
      <nav aria-label="Sections" className="grid shrink-0 grid-cols-4 border-t border-rule bg-night-2 pb-[env(safe-area-inset-bottom)] md:hidden">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] ${tab === id ? 'text-saffron' : 'text-ink-3'}`}
          >
            <Icon size={19} strokeWidth={1.9} aria-hidden />
            {label}
          </button>
        ))}
      </nav>
      <Bell />
    </div>
  );
}

function Game() {
  const session = useGame((s) => s.session);
  const hasHello = useGame((s) => s.assets.length > 0);
  const signedOut = useGame((s) => s.signedOut);
  useEffect(() => {
    game.start();
    return () => game.stop();
  }, []);
  if (signedOut) {
    location.reload();
    return null;
  }
  if (!hasHello) return <Splash />;
  if (!session) return <Splash text="Setting up the next session" />;
  return (
    <>
      {session.phase === 'lobby' ? <Lobby /> : session.phase === 'results' ? <Results /> : <Terminal />}
      <ConnectionPill />
      <Toasts />
    </>
  );
}

export function App() {
  const share = location.pathname.match(/^\/r\/([0-9a-f-]{36})$/i);
  const [me, setMe] = useState<{ user: unknown; session: SessionInfo | null; offset: number } | 'loading' | 'error'>('loading');

  const load = useCallback(() => {
    fetch('/api/me')
      .then((r) => r.json() as Promise<{ user: unknown; session: SessionInfo | null; serverNow: number }>)
      .then((m) => setMe({ user: m.user, session: m.session, offset: m.serverNow - Date.now() }))
      .catch(() => setMe('error'));
  }, []);
  useEffect(() => {
    if (!share) load();
  }, [load, share]);

  let body: React.ReactNode;
  if (share) body = <ShareCard id={share[1]!} />;
  else if (me === 'loading') body = <Splash />;
  else if (me === 'error')
    body = (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <p className="text-lg">The bazar is not reachable right now.</p>
          <button type="button" onClick={load} className="rounded-md bg-saffron px-5 py-2.5 font-bold text-night">
            Try again
          </button>
        </div>
      </div>
    );
  else if (!me.user) body = <Join session={me.session} offset={me.offset} onJoined={load} />;
  else body = <Game />;

  return <MotionConfig reducedMotion="user">{body}</MotionConfig>;
}
