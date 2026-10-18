import { useSyncExternalStore } from 'react';
import type {
  AssetInfo, Board, BookInfo, ClientMsg, EventInfo, RejectReason, Results, ServerMsg, SessionInfo,
} from '../../../server/src/protocol';
import { money } from './format';
import { uuid } from './uuid';

export type { AssetInfo, Board, BookInfo, EventInfo, PlayerResult, Results, SessionInfo } from '../../../server/src/protocol';

export type Conn = 'connecting' | 'open' | 'reconnecting';

export interface Point {
  tick: number;
  price: number;
}

export interface Toast {
  id: string;
  tone: 'up' | 'down' | 'warn';
  text: string;
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
  assets: AssetInfo[];
  prices: number[];
  prev: number[];
  tick: number;
  /** Per asset, in asset order. Mutated in place; `tick` changing is the signal. */
  history: Point[][];
  events: EventInfo[];
  /** The event the crier is currently calling out. */
  crier: EventInfo | null;
  book: BookInfo | null;
  spectating: 'full' | 'closed' | null;
  board: Board;
  results: Results | null;
  /** Set when the bell rings while we watch, so the ceremony plays once. */
  bellAt: number | null;
  pending: number;
  toasts: Toast[];
}

const REJECT_COPY: Record<RejectReason, string> = {
  insufficient_cash: 'Not enough cash for that order.',
  insufficient_shares: 'You do not own that many shares.',
  invalid_quantity: 'Enter a whole number of shares.',
  invalid_price: 'That price is not tradeable right now.',
  market_closed: 'The market is closed.',
  not_in_session: 'You are watching this session, not trading in it.',
  unknown_asset: 'That company is not listed.',
  duplicate: '',
  rate_limited: 'Slow down: too many orders at once.',
  bad_request: 'That order could not be read.',
  server_error: 'The order did not go through. Try again.',
};

const CRIER_MS = 7000;
/** A pending order older than this is not resent after a reconnect: the price has moved on. */
const RESEND_WINDOW_MS = 5000;

class Game {
  private state: GameState = {
    conn: 'connecting', signedOut: false, offset: 0, you: null, session: null, assets: [], prices: [], prev: [], tick: 0,
    history: [], events: [], crier: null, book: null, spectating: null, board: { top: [], count: 0, me: null },
    results: null, bellAt: null, pending: 0, toasts: [],
  };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retries = 0;
  private pending = new Map<string, Pending>();
  private crierTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.state;

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
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
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

  private receive(m: ServerMsg) {
    const s = this.state;
    switch (m.t) {
      case 'hello': {
        // The chart spaces points evenly, so the sampled history is filled back in to one point per tick.
        const tick = m.session?.tick ?? 0;
        const history = m.history.prices.map((series) => {
          const out: Point[] = [];
          series.forEach((price, i) => {
            const t = i === series.length - 1 ? tick : i * m.history.step;
            const from = out.at(-1);
            if (from) for (let k = from.tick + 1; k < t; k++) out.push({ tick: k, price: Math.round(from.price + ((price - from.price) * (k - from.tick)) / (t - from.tick)) });
            if (!from || t > from.tick) out.push({ tick: t, price });
          });
          return out;
        });
        const prices = m.history.prices.map((p) => p.at(-1) ?? 0);
        const isNewSession = s.session?.id !== m.session?.id;
        this.set({
          conn: 'open', signedOut: false, offset: m.serverNow - Date.now(), you: m.you, session: m.session,
          assets: m.assets, prices, prev: prices, tick, history, events: m.events, book: m.book,
          spectating: m.spectating, board: m.board, results: m.results,
          crier: isNewSession ? null : s.crier, bellAt: isNewSession ? null : s.bellAt,
        });
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
        if (m.k <= s.tick) break;
        m.p.forEach((price, i) => s.history[i]?.push({ tick: m.k, price }));
        this.set({ prev: s.prices, prices: m.p, tick: m.k, session: s.session && { ...s.session, tick: m.k } });
        break;
      }
      case 'phase': {
        const wasLobby = s.session?.phase === 'lobby';
        this.set({
          offset: m.serverNow - Date.now(),
          session: m.session,
          bellAt: wasLobby && m.session.phase === 'trading' && s.session?.id === m.session.id ? Date.now() : s.bellAt,
        });
        break;
      }
      case 'event': {
        if (s.events.some((e) => e.seq === m.ev.seq)) break;
        clearTimeout(this.crierTimer);
        // Phones get a shorter call: the band covers the top of whatever tab is open.
        this.crierTimer = setTimeout(() => this.set({ crier: null }), matchMedia('(min-width: 768px)').matches ? CRIER_MS : 4500);
        this.set({ events: [...s.events, m.ev], crier: m.ev });
        break;
      }
      case 'board':
        this.set({ board: m.board });
        break;
      case 'fill': {
        this.pending.delete(m.id);
        const verb = m.side === 'buy' ? 'Bought' : 'Sold';
        this.toast(m.side === 'buy' ? 'up' : 'down', `${verb} ${m.qty} ${m.ticker} at ${money(m.price)}`);
        this.set({ book: m.book, pending: this.pending.size });
        break;
      }
      case 'reject': {
        const had = this.pending.delete(m.id);
        if (m.reason !== 'duplicate' && (had || !m.id)) this.toast('warn', REJECT_COPY[m.reason]);
        this.set({ pending: this.pending.size });
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

  dismissCrier() {
    clearTimeout(this.crierTimer);
    this.set({ crier: null });
  }

  /** Sends a market order; returns false when it could not be sent at all. */
  order(side: 'buy' | 'sell', ticker: string, qty: number): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    const msg: ClientMsg = { t: 'order', id: uuid(), side, ticker, qty };
    this.pending.set(msg.id, { msg, sentAt: Date.now() });
    this.ws.send(JSON.stringify(msg));
    this.set({ pending: this.pending.size });
    return true;
  }
}

export const game = new Game();

export function useGame<T>(select: (s: GameState) => T): T {
  return useSyncExternalStore(game.subscribe, () => select(game.get()));
}

export const now = (offset: number) => Date.now() + offset;
