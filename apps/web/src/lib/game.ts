import { useSyncExternalStore } from 'react';
import type {
  AssetInfo, Board, BookInfo, ClientMsg, EventInfo, MarketInfo, Regime, RejectReason, Results, ServerMsg, SessionInfo, TradeInfo,
} from '../../../server/src/protocol';
import { money } from './format';
import { uuid } from './uuid';

export type {
  AssetInfo, Board, BoardRow, BookInfo, EventInfo, FullBoard, HoldingResult, PlayerResult, PortfolioView, PriceHistory, Range, Regime, Report, Results,
  RoomInfo, RoomListing, SessionInfo, Summary, TradeInfo,
} from '../../../server/src/protocol';

/** The custom room this page is in (/room/CODE), or null for the house competition. */
export const ROOM = globalThis.location?.pathname.match(/^\/room\/([A-Z2-9]{8})\/?$/)?.[1] ?? null;
/** `?room=CODE` for every request that is about this page's competition. */
export const roomQuery = ROOM ? `?room=${ROOM}` : '';

/** Whether a story belongs on this competition's screens: the shared tape also carries news about companies it does not list. */
export function concernsListing(ev: EventInfo, tickers: Set<string>, sectors: Set<string>) {
  if (ev.scope === 'sector') return sectors.has(ev.target ?? '');
  if (ev.scope === 'asset' || ev.scope === 'basket') return ev.related.some((t) => tickers.has(t)) || tickers.has(ev.target ?? '');
  return true;
}

export type Conn = 'connecting' | 'open' | 'reconnecting';

export interface Toast {
  id: string;
  tone: 'up' | 'down' | 'warn';
  text: string;
}

/** What happened to an order this tab sent, for the ticket that sent it. */
export interface Outcome {
  id: string;
  ok: boolean;
  text: string;
}

/** One market tick as received: the chart folds these into its bars. */
export interface Tick {
  seq: number;
  at: number;
  p: number[];
}

interface Pending {
  msg: ClientMsg;
  sentAt: number;
}

export interface GameState {
  conn: Conn;
  /** True after the server said our cookie is no longer valid. */
  signedOut: boolean;
  /** serverNow - Date.now(), so countdowns match the server clock. */
  offset: number;
  you: { userId: string; nickname: string } | null;
  session: SessionInfo | null;
  /** Listing in price-array order; empty until /api/market has loaded. */
  assets: AssetInfo[];
  index: Map<string, number>;
  prices: number[];
  prev: number[];
  /** Prices at the competition's opening bell: the change column is measured from here. */
  open: number[];
  seq: number;
  /** Server time of the last tick, and when it arrived here, for the stale-data warning. */
  at: number;
  receivedAt: number;
  regime: Regime;
  /** Corporate credit spread, percentage points: what companies pay to borrow over government debt. */
  credit: number;
  /** Published news, newest first. */
  events: EventInfo[];
  /** The story the news strip is calling out, until it settles or is dismissed. */
  breaking: EventInfo | null;
  /** Stories that landed while the news view was closed. */
  unread: number;
  book: BookInfo | null;
  trades: TradeInfo[];
  spectating: 'full' | 'closed' | 'late' | null;
  board: Board;
  results: Results | null;
  /** Set when the bell rings while we watch, so the ceremony plays once. */
  bellAt: number | null;
  pending: number;
  outcome: Outcome | null;
  toasts: Toast[];
  favourites: string[];
  recent: string[];
}

const REJECT_COPY: Record<RejectReason, string> = {
  insufficient_cash: 'Not enough cash for that order.',
  insufficient_shares: 'You do not own that many shares.',
  invalid_quantity: 'Enter a whole number of shares.',
  invalid_price: 'That price is not tradeable right now.',
  market_closed: 'The market is closed, so the order was not placed.',
  not_in_session: 'You are watching this competition, not trading in it.',
  unknown_asset: 'That company is not listed.',
  duplicate: '',
  rate_limited: 'Slow down: too many orders at once.',
  bad_request: 'That order could not be read.',
  server_error: 'The order did not go through. Try again.',
};

/** How long a story stays called out in the strip. */
const BREAKING_MS = 9000;
/** A pending order older than this is not resent after a reconnect: the price has moved on. */
const RESEND_WINDOW_MS = 5000;
/** Ticks kept for charts: an hour at one per second. */
const TICKS_KEPT = 3600;

const PREFS_KEY = 'haggle:prefs';
function loadPrefs(): { favourites: string[]; recent: string[] } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { favourites?: unknown; recent?: unknown };
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === 'string').slice(0, 30) : []);
    return { favourites: list(p.favourites), recent: list(p.recent) };
  } catch {
    return { favourites: [], recent: [] };
  }
}

class Game {
  private state: GameState = {
    conn: 'connecting', signedOut: false, offset: 0, you: null, session: null, assets: [], index: new Map(), prices: [], prev: [], open: [],
    seq: 0, at: 0, receivedAt: 0, regime: 'calm', credit: 0, events: [], breaking: null, unread: 0, book: null, trades: [], spectating: null,
    board: { top: [], count: 0, me: null, at: 0 }, results: null, bellAt: null, pending: 0, outcome: null, toasts: [], ...loadPrefs(),
  };
  /** Recent ticks, outside React state: charts read them, nothing re-renders on them. */
  readonly ticks: Tick[] = [];
  private tickListeners = new Set<(t: Tick) => void>();
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retries = 0;
  private pending = new Map<string, Pending>();
  private breakingTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private tickers: string[] = [];
  /** Where each listed company sits in the market's full price array; everything past receive() sees only these. */
  private picks: number[] = [];
  private listedSet = new Set<string>();
  private sectors = new Set<string>();
  private newsOpen = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.state;

  onTick(fn: (t: Tick) => void): () => void {
    this.tickListeners.add(fn);
    return () => void this.tickListeners.delete(fn);
  }

  private set(patch: Partial<GameState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.ws?.close();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${roomQuery}`);
    this.ws = ws;
    ws.onmessage = (e) => this.receive(JSON.parse(e.data as string) as ServerMsg);
    ws.onopen = () => (this.retries = 0);
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.set({ conn: 'reconnecting' });
      // A refused upgrade looks like any other close; ask the API whether we are still signed in.
      fetch('/api/me')
        .then((r) => r.json() as Promise<{ user: unknown }>)
        .then((me) => {
          if (!me.user) return this.set({ signedOut: true });
          this.retry();
        })
        .catch(() => this.retry());
    };
  }

  private retry() {
    const delay = Math.min(8000, 500 * 2 ** this.retries++) * (0.75 + Math.random() * 0.5);
    setTimeout(() => !this.stopped && this.connect(), delay);
  }

  /** The listing changes only when a company reports, so it is fetched, not pushed on every connect. */
  private async loadMarket(tickers: string[]) {
    const r = await fetch('/api/market');
    if (!r.ok) throw new Error(`market ${r.status}`);
    const m = (await r.json()) as MarketInfo;
    const byTicker = new Map(m.assets.map((a) => [a.ticker, a]));
    const assets = tickers.flatMap((t) => byTicker.get(t) ?? []);
    this.set({ assets, index: new Map(assets.map((a, i) => [a.ticker, i])) });
  }

  loadTrades() {
    fetch(`/api/me/trades${roomQuery}`)
      .then((r) => r.json() as Promise<{ trades: TradeInfo[] }>)
      .then(({ trades }) => this.set({ trades }))
      .catch(() => {});
  }

  private listedPrices(p: number[]) {
    return this.picks.map((i) => p[i]!);
  }

  private receive(m: ServerMsg) {
    const s = this.state;
    switch (m.t) {
      case 'hello': {
        const isNewSession = s.session?.id !== m.session?.id;
        const changed = m.listed.join() !== this.tickers.join();
        this.tickers = m.listed;
        this.picks = m.listed.map((t) => m.tickers.indexOf(t));
        this.listedSet = new Set(m.listed);
        this.sectors = new Set(m.sectors);
        const events = m.events.filter((e) => concernsListing(e, this.listedSet, this.sectors));
        const prices = this.listedPrices(m.prices);
        // A reconnect starts the chart buffer over: the gap is fetched from the server, never guessed.
        this.ticks.length = 0;
        const known = new Set(s.events.map((e) => e.id));
        this.set({
          conn: 'open', signedOut: false, offset: m.serverNow - Date.now(), you: m.you, session: m.session,
          prices, prev: prices, open: this.listedPrices(m.open), seq: m.seq, at: m.at, receivedAt: Date.now(), regime: m.regime, credit: m.credit,
          events, book: m.book, spectating: m.spectating, board: m.board, results: m.results,
          bellAt: isNewSession ? null : s.bellAt,
          // Stories from before this tab existed are not news to it; ones missed while away are.
          unread: s.events.length ? s.unread + events.filter((e) => !known.has(e.id)).length : 0,
          trades: isNewSession ? [] : s.trades,
        });
        if (changed || !s.assets.length) {
          this.loadMarket(m.listed).catch(() => this.toast('warn', 'Company data did not load. Reconnecting will retry.'));
        }
        if (m.book) this.loadTrades();
        // Orders sent just before a drop are resent with the same id: the server executes each id once.
        for (const [id, p] of this.pending) {
          if (Date.now() - p.sentAt < RESEND_WINDOW_MS) this.ws?.send(JSON.stringify(p.msg));
          else {
            this.pending.delete(id);
            this.toast('warn', 'An order sent before the connection dropped was not confirmed. Check your holdings.');
          }
        }
        this.set({ pending: this.pending.size });
        break;
      }
      case 'tick': {
        // Ticks carry the market's sequence number: a duplicate or a late one is dropped, not replayed.
        if (m.k <= s.seq) break;
        const t = { seq: m.k, at: m.at, p: this.listedPrices(m.p) };
        this.ticks.push(t);
        if (this.ticks.length > TICKS_KEPT) this.ticks.splice(0, this.ticks.length - TICKS_KEPT);
        this.set({ prev: s.prices, prices: t.p, seq: m.k, at: m.at, receivedAt: Date.now(), session: s.session && { ...s.session, tick: s.session.tick + 1 } });
        for (const fn of this.tickListeners) fn(t);
        break;
      }
      case 'phase': {
        const wasLobby = s.session?.phase === 'lobby';
        this.set({
          offset: m.serverNow - Date.now(),
          session: m.session,
          open: this.listedPrices(m.open),
          bellAt: wasLobby && m.session.phase === 'trading' && s.session?.id === m.session.id ? Date.now() : s.bellAt,
        });
        break;
      }
      case 'event': {
        if (s.events.some((e) => e.id === m.ev.id) || !concernsListing(m.ev, this.listedSet, this.sectors)) break;
        clearTimeout(this.breakingTimer);
        this.breakingTimer = setTimeout(() => this.set({ breaking: null }), BREAKING_MS);
        this.set({ events: [m.ev, ...s.events].slice(0, 60), breaking: m.ev, unread: this.newsOpen ? 0 : s.unread + 1 });
        break;
      }
      case 'fund': {
        const i = s.index.get(m.ticker);
        if (i === undefined) break;
        const assets = s.assets.slice();
        assets[i] = { ...assets[i]!, fund: m.fund };
        this.set({ assets });
        break;
      }
      case 'regime':
        this.set({ regime: m.regime, credit: m.credit });
        break;
      case 'board':
        this.set({ board: m.board });
        break;
      case 'fill': {
        this.pending.delete(m.id);
        const verb = m.side === 'buy' ? 'Bought' : 'Sold';
        const text = `${verb} ${m.qty} ${m.ticker} at ${money(m.price)}, ${money(m.total)} in all`;
        this.toast(m.side === 'buy' ? 'up' : 'down', text);
        this.set({
          book: m.book, pending: this.pending.size, outcome: { id: m.id, ok: true, text },
          trades: s.trades.some((t) => t.id === m.trade.id) ? s.trades : [m.trade, ...s.trades],
        });
        break;
      }
      case 'reject': {
        const had = this.pending.delete(m.id);
        if (m.reason === 'duplicate') {
          this.set({ pending: this.pending.size });
          break;
        }
        if (had || !m.id) this.toast('warn', REJECT_COPY[m.reason]);
        this.set({ pending: this.pending.size, outcome: { id: m.id, ok: false, text: REJECT_COPY[m.reason] } });
        break;
      }
      case 'results':
        this.set({ results: m.results });
        break;
    }
  }

  private toast(tone: Toast['tone'], text: string) {
    const t = { id: uuid(), tone, text };
    this.set({ toasts: [...this.state.toasts, t].slice(-3) });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((x) => x !== t) }), 3500);
  }

  dismissBreaking() {
    clearTimeout(this.breakingTimer);
    this.set({ breaking: null });
  }

  /** The news view is on screen: what lands now is read as it lands. */
  setNewsOpen(open: boolean) {
    this.newsOpen = open;
    if (open && this.state.unread) this.set({ unread: 0 });
  }

  /** Sends a market order; returns its id, or null when it could not be sent at all. */
  order(side: 'buy' | 'sell', ticker: string, qty: number): string | null {
    if (this.ws?.readyState !== WebSocket.OPEN) return null;
    const msg: ClientMsg = { t: 'order', id: uuid(), side, ticker, qty };
    this.pending.set(msg.id, { msg, sentAt: Date.now() });
    this.ws.send(JSON.stringify(msg));
    this.set({ pending: this.pending.size });
    return msg.id;
  }

  private savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ favourites: this.state.favourites, recent: this.state.recent }));
    } catch {
      // Private mode or blocked storage: favourites last as long as the tab.
    }
  }

  toggleFavourite(ticker: string) {
    const f = this.state.favourites;
    this.set({ favourites: f.includes(ticker) ? f.filter((t) => t !== ticker) : [ticker, ...f].slice(0, 30) });
    this.savePrefs();
  }

  visit(ticker: string) {
    if (this.state.recent[0] === ticker) return;
    this.set({ recent: [ticker, ...this.state.recent.filter((t) => t !== ticker)].slice(0, 8) });
    this.savePrefs();
  }
}

export const game = new Game();

export function useGame<T>(select: (s: GameState) => T): T {
  return useSyncExternalStore(game.subscribe, () => select(game.get()));
}

export const now = (offset: number) => Date.now() + offset;
