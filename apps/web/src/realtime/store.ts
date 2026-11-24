import { useEffect, useSyncExternalStore } from 'react';
import type {
  Execution, ExchangeStatus, FeedInfo, Instrument, Notification, PriceStatus, Quote, ServerMsg,
} from '../../../server/src/realtime/types';

export type * from '../../../server/src/realtime/types';

export class HttpError extends Error {
  constructor(public status: number, public body: { error?: string; reason?: string }) {
    super(body.error ?? body.reason ?? `HTTP ${status}`);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(`/api/rt${path}`, {
    ...init,
    headers: init?.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : {};
  if (!r.ok) throw new HttpError(r.status, body);
  return body as T;
}

// ---------------------------------------------------------------- live store

export interface Live {
  conn: 'connecting' | 'open' | 'reconnecting';
  offset: number;
  quotes: Map<number, Quote>;
  instruments: Map<number, Instrument>;
  exchanges: ExchangeStatus[];
  feed: FeedInfo | null;
  /** Bumped on every own order or fill, so pages showing orders and the portfolio reload. */
  version: number;
  notes: Notification[];
  toasts: { id: number; text: string; tone: 'up' | 'down' | 'info' }[];
  watch: Set<number>;
}

let state: Live = {
  conn: 'connecting', offset: 0, quotes: new Map(), instruments: new Map(), exchanges: [], feed: null, version: 0, notes: [], toasts: [], watch: new Set(),
};
const listeners = new Set<() => void>();
const set = (patch: Partial<Live>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
export const live = () => state;
export function useLive<T>(select: (s: Live) => T): T {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => select(state));
}

let ws: WebSocket | null = null;
let retries = 0;
const wanted = new Map<number, number>();

function send(m: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

let toastId = 0;
export function toast(text: string, tone: 'up' | 'down' | 'info' = 'info') {
  const id = ++toastId;
  set({ toasts: [...state.toasts, { id, text, tone }].slice(-4) });
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), 5000);
}

function onMessage(m: ServerMsg) {
  if (m.t === 'hello') {
    set({ offset: m.serverNow - Date.now(), conn: 'open' });
    retries = 0;
    if (wanted.size) send({ t: 'sub', ids: [...wanted.keys()] });
  } else if (m.t === 'q') {
    const quotes = new Map(state.quotes);
    for (const q of m.q) {
      const prev = quotes.get(q.id);
      if (!prev || prev.at <= q.at) quotes.set(q.id, q);
    }
    set({ quotes });
  } else if (m.t === 'order') set({ version: state.version + 1 });
  else if (m.t === 'fill') {
    const e: Execution = m.execution;
    toast(`${e.side === 'buy' ? 'Bought' : 'Sold'} ${shares(e.qty)} ${e.instrument.symbol} at ${price(e.price, e.instrument.currency)}`, e.side === 'buy' ? 'up' : 'down');
    set({ version: state.version + 1 });
  } else if (m.t === 'note') set({ notes: [m.n, ...state.notes].slice(0, 50) });
}

export function connect() {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/rt/ws`);
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data as string));
    } catch {
      /* a malformed frame is dropped */
    }
  };
  ws.onclose = () => {
    ws = null;
    set({ conn: 'reconnecting' });
    setTimeout(connect, Math.min(15_000, 500 * 2 ** retries++));
  };
}

/** Subscribes the screen to live prices for these instruments while the component is mounted. */
export function useQuotes(ids: number[]) {
  const key = ids.join(',');
  useEffect(() => {
    const list = key ? key.split(',').map(Number) : [];
    const add = list.filter((id) => !wanted.has(id));
    for (const id of list) wanted.set(id, (wanted.get(id) ?? 0) + 1);
    if (add.length) send({ t: 'sub', ids: add });
    // Fill the gap until the socket delivers: cached quotes over HTTP.
    const missing = list.filter((id) => !state.quotes.has(id) || !state.instruments.has(id));
    if (missing.length) void loadQuotes(missing);
    return () => {
      const drop: number[] = [];
      for (const id of list) {
        const n = (wanted.get(id) ?? 1) - 1;
        if (n <= 0) {
          wanted.delete(id);
          drop.push(id);
        } else wanted.set(id, n);
      }
      if (drop.length) send({ t: 'unsub', ids: drop });
    };
  }, [key]);
}

export async function loadQuotes(ids: number[]) {
  for (let k = 0; k < ids.length; k += 300) {
    const body = await api<{ instruments: Instrument[]; quotes: Quote[] }>(`/quotes?ids=${ids.slice(k, k + 300).join(',')}`).catch(() => null);
    if (!body) return;
    remember(body.instruments);
    const quotes = new Map(state.quotes);
    for (const q of body.quotes) if (!quotes.has(q.id) || quotes.get(q.id)!.at < q.at) quotes.set(q.id, q);
    set({ quotes });
  }
}

export function remember(list: Instrument[]) {
  if (!list.length) return;
  const instruments = new Map(state.instruments);
  for (const i of list) instruments.set(i.id, i);
  set({ instruments });
}

export async function loadStatus() {
  const s = await api<{ serverNow: number; exchanges: ExchangeStatus[]; feed: FeedInfo }>('/status');
  set({ exchanges: s.exchanges, feed: s.feed, offset: s.serverNow - Date.now() });
}

export async function loadWatch() {
  const w = await api<{ ids: number[] }>('/watchlist').catch(() => ({ ids: [] }));
  set({ watch: new Set(w.ids) });
}
export async function toggleWatch(id: number) {
  const on = !state.watch.has(id);
  const w = await api<{ ids: number[] }>(`/watchlist/${id}`, { method: on ? 'PUT' : 'DELETE' });
  set({ watch: new Set(w.ids) });
}

export async function loadNotes() {
  const n = await api<{ notifications: Notification[] }>('/notifications').catch(() => null);
  if (n) set({ notes: n.notifications });
}
export async function readNotes() {
  await api('/notifications/read', { method: 'POST', json: {} }).catch(() => {});
  set({ notes: state.notes.map((n) => ({ ...n, read: true })) });
}

const RECENT = 'haggle:rt:recent';
export const recent = (): number[] => {
  try {
    return (JSON.parse(localStorage.getItem(RECENT) ?? '[]') as unknown[]).filter((x): x is number => typeof x === 'number').slice(0, 12);
  } catch {
    return [];
  }
};
export const pushRecent = (id: number) => localStorage.setItem(RECENT, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 12)));

// ---------------------------------------------------------------- the clock

export function statusOf(i: Pick<Instrument, 'exchange'>): ExchangeStatus | undefined {
  return state.exchanges.find((e) => e.exchange === i.exchange);
}

/** The same as the server's priceStatus, so a quote turns stale on screen without a message. */
export function priceStatus(q: Quote | undefined, ex: ExchangeStatus | undefined, now: number, maxAgeSec: number): PriceStatus {
  if (!q) return 'none';
  if (!ex || ex.state === 'closed' || ex.state === 'holiday' || ex.state === 'break') return 'closed';
  if (now - q.at - q.delayMin * 60_000 > maxAgeSec * 1000) return 'stale';
  return q.quality;
}

// ---------------------------------------------------------------- formatting

const symbolFor = (c: string) => (c === 'GBp' || c === 'GBX' ? 'GBP' : c);
const fmt = new Map<string, Intl.NumberFormat>();
/** A price in 1/10,000 units of its currency. LSE pence are shown as pence. */
export function price(units: number | null | undefined, currency: string): string {
  if (units === null || units === undefined) return '—';
  const v = units / 10_000;
  if (currency === 'GBp' || currency === 'GBX') return `${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}p`;
  const digits = v < 1 ? 4 : 2;
  const key = `${currency}:${digits}`;
  if (!fmt.has(key)) {
    try {
      fmt.set(key, new Intl.NumberFormat('en-IE', { style: 'currency', currency: symbolFor(currency), minimumFractionDigits: digits, maximumFractionDigits: digits }));
    } catch {
      fmt.set(key, new Intl.NumberFormat('en-IE', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    }
  }
  return fmt.get(key)!.format(v);
}
/** An index level: points, no currency sign. */
export const level = (units: number | null | undefined) => (units == null ? '—' : (units / 10_000).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const shares = (micro: number) => {
  const v = micro / 1_000_000;
  return Number.isInteger(v) ? v.toLocaleString('en-IE') : v.toLocaleString('en-IE', { maximumFractionDigits: 6 });
};
export const compact = (n: number | null | undefined) => (n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
export const dayBps = (q: Quote | undefined) => (q?.last && q.prevClose ? Math.round(((q.last - q.prevClose) * 10_000) / q.prevClose) : null);

export function countdown(ms: number) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export const REJECT_COPY: Record<string, string> = {
  insufficient_cash: 'Not enough cash for this order.',
  insufficient_shares: 'You do not hold that many shares (shares in open sell orders are set aside).',
  invalid_quantity: 'Enter a quantity above zero.',
  invalid_price: 'Enter a limit price above zero.',
  market_closed: 'This exchange is not trading now. Market orders need the regular session.',
  stale_quote: 'The latest price is too old to trade on. Try again in a moment.',
  no_quote: 'No price is available for this instrument right now.',
  delayed_quote: 'Only delayed prices are available here, and delayed prices cannot be traded on.',
  halted: 'Trading in this instrument is halted.',
  delisted: 'This instrument is no longer listed.',
  season_closed: 'This competition is not open for trading.',
  not_joined: 'Join this competition first.',
  unknown_instrument: 'Instrument not found.',
  rate_limited: 'Slow down: too many orders in a short time.',
  not_supported: 'Indices cannot be traded. Buy an ETF that tracks it instead.',
  bad_request: 'That order is not valid.',
};

export const STATE_LABEL: Record<string, string> = {
  pre: 'Pre-market', open: 'Market open', break: 'Lunch break', post: 'After-hours', closed: 'Closed', holiday: 'Holiday',
};

/** Router: /realtime/<page>/<arg>, history API, one listener. */
export function useRoute(): string[] {
  return useSyncExternalStore(
    (l) => (addEventListener('popstate', l), () => removeEventListener('popstate', l)),
    () => location.pathname,
  ).replace(/^\/realtime\/?/, '').split('/').filter(Boolean);
}
export function go(path: string) {
  history.pushState(null, '', `/realtime${path}`);
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo({ top: 0 });
}
