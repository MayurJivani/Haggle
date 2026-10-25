import { MotionConfig } from 'motion/react';
import { ArrowLeft, BarChart3, LineChart, Newspaper, Store, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Bell, Join, Lobby, Results, ShareCard, Splash } from './components/ceremony';
import { Overview, Screener } from './components/dashboard';
import { Host } from './components/host';
import { ConnectionPill, Toasts, TopBar, useMedia, useNow } from './components/chrome';
import { CompanyPanel, Holdings, OrderPanel, SectorList, SectorPanel, StockList } from './components/floor';
import { Feed, NewsStrip, Roster } from './components/side';
import { clock } from './lib/format';
import { game, ROOM, roomQuery, useGame, type SessionInfo } from './lib/game';
import { RoomBar, RoomsPage } from './components/rooms';

type Tab = 'market' | 'stock' | 'portfolio' | 'news' | 'board';
const TABS: { id: Tab; label: string; Icon: typeof Store }[] = [
  { id: 'market', label: 'Market', Icon: Store },
  { id: 'stock', label: 'Stock', Icon: LineChart },
  { id: 'portfolio', label: 'Purse', Icon: Wallet },
  { id: 'news', label: 'News', Icon: Newspaper },
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

type View = 'overview' | 'stocks' | 'sectors';

/** The ways into the listing: the market overview (phones only), stocks and sectors. */
function Browse({ view, setView, selected, onSelect, onSector, onHoldings, onRoster, phone = false }: {
  view: View; setView: (v: View) => void; selected: string; onSelect: (t: string) => void; onSector: (s: string) => void;
  onHoldings: () => void; onRoster: () => void; phone?: boolean;
}) {
  const views: View[] = phone ? ['overview', 'stocks', 'sectors'] : ['stocks', 'sectors'];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Browse" className={`grid shrink-0 border-b border-rule ${phone ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {views.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`h-10 font-display text-[15px] font-bold uppercase tracking-[0.06em] ${view === v ? 'bg-night-3 text-ink' : 'text-ink-3 hover:text-ink'}`}
          >
            {v}
          </button>
        ))}
      </div>
      {view === 'overview' ? (
        <div className="min-h-0 flex-1 overflow-y-auto"><Overview onSelect={onSelect} onSector={onSector} onHoldings={onHoldings} onRoster={onRoster} /></div>
      ) : view === 'stocks' ? (
        <StockList selected={selected} onSelect={onSelect} />
      ) : (
        <SectorList onSector={onSector} />
      )}
    </div>
  );
}

function Spectating() {
  const spectating = useGame((s) => s.spectating);
  const room = useGame((s) => s.session?.room);
  if (spectating !== 'full' && spectating !== 'late') return null;
  return (
    <p className="shrink-0 bg-saffron-deep px-4 py-1.5 text-center text-[13px] text-saffron" role="status">
      {spectating === 'late'
        ? 'This room does not take traders after the bell, so you are watching.'
        : `This competition is full, so you are watching.${room ? '' : ' You will be dealt into the next one.'}`}
    </p>
  );
}

function Terminal() {
  const assets = useGame((s) => s.assets);
  const unread = useGame((s) => s.unread);
  const [ticker, setTicker] = useState<string | null>(null);
  const [sector, setSector] = useState<string | null>(null);
  const [browse, setBrowse] = useState<View>('overview');
  const [tab, setTab] = useState<Tab>('market');
  // Desktop centre column: the overview, the screener, or the company last opened.
  const [main, setMain] = useState<'overview' | 'screener' | 'company'>('overview');
  const phone = useMedia('(max-width: 767px)');
  const wide = useMedia('(min-width: 1280px)');
  const selected = ticker ?? assets[0]?.ticker ?? '';
  const pick = useCallback((t: string) => {
    setTicker(t);
    setSector(null);
    setTab('stock');
    setMain('company');
  }, []);
  // Each target is a phone tab, or a panel of the desktop layout scrolled into view.
  const show = (t: Tab, id: string) => () => {
    setTab(t);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const openNews = show('news', 'news');
  const openHoldings = show('portfolio', 'holdings');
  const openRoster = show('board', 'roster');

  const browseProps = {
    view: browse === 'overview' ? 'stocks' as const : browse, setView: setBrowse, selected, onSelect: pick, onSector: setSector, onHoldings: openHoldings, onRoster: openRoster,
  };

  if (phone) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopBar />
        <NewsStrip onOpen={openNews} />
        <LastCalls />
        <RoomBar />
        <Spectating />
        <main className="flex min-h-0 flex-1 flex-col">
          {tab === 'market' && (sector ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <button type="button" onClick={() => setSector(null)} className="flex h-10 shrink-0 items-center gap-1.5 border-b border-rule px-3 text-[13px] font-semibold text-ink-2">
                <ArrowLeft size={16} aria-hidden /> All sectors
              </button>
              <SectorPanel sector={sector} onSelect={pick} />
            </div>
          ) : <Browse {...browseProps} view={browse} phone />)}
          {tab === 'stock' && selected && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto"><CompanyPanel ticker={selected} onSelect={pick} /></div>
              {/* The order dock is part of the page, not laid over it: nothing it does can cover the research above. */}
              <div className="shrink-0 border-t border-rule bg-night-2"><OrderPanel ticker={selected} dock /></div>
            </div>
          )}
          {tab === 'portfolio' && <div className="min-h-0 flex-1 overflow-y-auto"><Holdings onSelect={pick} /></div>}
          {tab === 'news' && <Feed onSelect={pick} track />}
          {tab === 'board' && <div className="min-h-0 flex-1 overflow-y-auto"><Roster limit={10} /></div>}
        </main>
        <nav aria-label="Sections" className="grid shrink-0 grid-cols-5 border-t border-rule bg-night-2 pb-[env(safe-area-inset-bottom)]">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] ${tab === id ? 'text-saffron' : 'text-ink-3'}`}
            >
              <Icon size={19} strokeWidth={1.9} aria-hidden />
              {label}
              {id === 'news' && unread > 0 && tab !== 'news' && (
                <span className="absolute right-[calc(50%-1.4rem)] top-1.5 min-w-4 rounded-full bg-saffron px-1 text-[10px] leading-4 text-night" aria-label={`${unread} new`}>
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          ))}
        </nav>
        <Bell />
      </div>
    );
  }

  const side = (
    <>
      <div id="roster"><Roster /></div>
      <div id="news" className="flex min-h-[24rem] flex-col border-t border-rule"><Feed onSelect={pick} /></div>
    </>
  );
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <NewsStrip onOpen={openNews} />
      <LastCalls />
      <RoomBar />
      <Spectating />
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_340px]">
        <aside aria-label="Stocks and sectors" className="flex min-h-0 flex-col border-r border-rule bg-night-2">
          <Browse {...browseProps} />
        </aside>
        <main className="flex min-h-0 flex-col overflow-y-auto">
          <nav aria-label="Views" className="flex h-10 shrink-0 items-stretch gap-1 border-b border-rule px-3">
            {([['overview', 'Overview'], ['screener', 'Screener'], ['company', selected]] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setSector(null);
                  setMain(id);
                }}
                aria-current={main === id && !sector ? 'page' : undefined}
                className={`relative px-3 font-display text-[15px] font-bold uppercase tracking-[0.06em] ${main === id && !sector ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
              >
                {label}
                {main === id && !sector && <span className="absolute inset-x-2 bottom-0 h-[2px] bg-saffron" aria-hidden />}
              </button>
            ))}
            {sector && <span className="flex items-center px-3 font-display text-[15px] font-bold uppercase tracking-[0.06em] text-ink" aria-current="page">{sector}</span>}
          </nav>
          {sector ? (
            <>
              <button type="button" onClick={() => setSector(null)} className="flex h-9 shrink-0 items-center gap-1.5 border-b border-rule px-4 text-[13px] font-semibold text-ink-2 hover:text-ink">
                <ArrowLeft size={15} aria-hidden /> Back to {main === 'company' ? selected : main}
              </button>
              <SectorPanel sector={sector} onSelect={pick} />
            </>
          ) : main === 'overview' ? (
            <Overview onSelect={pick} onSector={setSector} onHoldings={openHoldings} onRoster={openRoster} />
          ) : main === 'screener' ? (
            <Screener onSelect={pick} />
          ) : (
            <div className="flex shrink-0 flex-col lg:min-h-[560px] lg:flex-[1_0_auto] lg:flex-row">
              <div className="flex min-h-[440px] min-w-0 flex-1 flex-col">{selected && <CompanyPanel ticker={selected} onSelect={pick} />}</div>
              <div className="border-rule lg:w-[300px] lg:shrink-0 lg:border-l">{selected && <OrderPanel ticker={selected} />}</div>
            </div>
          )}
          <div id="holdings" className="scroll-mt-2 border-t border-rule">
            <Holdings onSelect={pick} />
          </div>
          {!wide && <div className="grid grid-cols-2 border-t border-rule [&>*:last-child]:border-l [&>*:last-child]:border-t-0 [&>*:last-child]:border-rule">{side}</div>}
        </main>
        {wide && (
          <aside aria-label="Roster and news" className="flex min-h-0 flex-col overflow-y-auto border-l border-rule bg-night-2">
            {side}
          </aside>
        )}
      </div>
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
  const isHost = location.pathname.replace(/\/$/, '') === '/host';
  const isRooms = location.pathname.replace(/\/$/, '') === '/rooms';
  const badRoom = location.pathname.startsWith('/room/') && !ROOM;
  const [me, setMe] = useState<{ user: unknown; session: SessionInfo | null; offset: number } | 'loading' | 'error' | 'noroom'>('loading');

  const load = useCallback(() => {
    Promise.all([
      fetch(`/api/me${roomQuery}`).then((r) => r.json() as Promise<{ user: unknown; session: SessionInfo | null; serverNow: number }>),
      ROOM ? fetch(`/api/rooms/${ROOM}`).then((r) => r.ok) : true,
    ])
      .then(([m, found]) => setMe(found ? { user: m.user, session: m.session, offset: m.serverNow - Date.now() } : 'noroom'))
      .catch(() => setMe('error'));
  }, []);
  useEffect(() => {
    if (!share && !isHost) load();
  }, [load, share, isHost]);

  let body: React.ReactNode;
  if (isHost) body = <Host />;
  else if (share) body = <ShareCard id={share[1]!} />;
  else if (badRoom || me === 'noroom')
    body = (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <p className="text-lg">There is no room with that code.</p>
          <a href="/rooms" className="rounded-md bg-saffron px-5 py-2.5 font-bold text-night">See open rooms</a>
        </div>
      </div>
    );
  else if (me === 'loading') body = <Splash />;
  else if (isRooms && me !== 'error') body = <RoomsPage signedIn={!!me.user} />;
  else if (me === 'error')
    body = (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <p className="text-lg">Haggle is not reachable right now.</p>
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
