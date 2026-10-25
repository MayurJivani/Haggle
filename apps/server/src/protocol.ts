// Wire format shared with apps/web (type-only import). Money is integer cents, returns are basis points.
// Nothing here carries an event's price impact, a company's event sensitivities or an unpublished
// story: clients see what happened, never what the market will do about it.

import type { Category, Figure, Scope } from './market/events.js';
import type { Report, Summary } from './market/fundamentals.js';

export type { Category, Figure, Report, Scope, Summary };

export type Phase = 'lobby' | 'trading' | 'closing' | 'results';

export interface SessionInfo {
  id: string;
  phase: Phase;
  /** Epoch ms. */
  opensAt: number;
  closingAt: number;
  closesAt: number;
  /** When the next lobby opens (results phase only). */
  nextAt: number | null;
  tick: number;
  totalTicks: number;
  tickMs: number;
  players: number;
  maxPlayers: number;
  /** The purse this competition was started with, in cents. */
  startingCash: number;
}

export interface AssetInfo {
  ticker: string;
  name: string;
  exchange: string;
  sector: string;
  industry: string;
  description: string;
  /** Market sensitivity, as a research figure. */
  beta: number;
  risk: 'low' | 'medium' | 'high';
  fund: Summary;
}

/** GET /api/market: the listing, which changes only when a company reports. */
export interface MarketInfo {
  assets: AssetInfo[];
}

/** One published story. */
export interface EventInfo {
  id: number;
  sessionId: string;
  /** Market sequence number it landed on, and when. */
  seq: number;
  at: number;
  category: Category;
  scope: Scope;
  /** The company ticker, sector name or macro factor the story is about; null for market-wide news. */
  target: string | null;
  related: string[];
  headline: string;
  body: string;
  figures: Figure[];
  severity: 1 | 2 | 3;
}

export interface TradeInfo {
  id: number;
  at: number;
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  total: number;
  realized: number;
}

export type Regime = 'calm' | 'nervous' | 'stressed';

export type Range = '1m' | '5m' | '15m' | '1h' | '1d' | '1w' | '1mo' | 'all';

/** GET /api/prices/:ticker?range=: [at ms, open, high, low, close, last seq] per bucket. */
export interface PriceHistory {
  ticker: string;
  range: Range;
  bucketMs: number;
  bars: [number, number, number, number, number, number][];
  /** First and last stored point for this company, so the client offers only ranges the data covers. */
  span: { first: number; last: number } | null;
  sessions: { id: string; opensAt: number; closesAt: number }[];
}

export interface PositionInfo {
  ticker: string;
  qty: number;
  cost: number;
  realized: number;
}

export interface BookInfo {
  participantId: string;
  cash: number;
  positions: PositionInfo[];
  trades: number;
}

export interface BoardRow {
  rank: number;
  nickname: string;
  value: number;
  bps: number;
  trades: number;
  /** Ticker of the player's largest holding by value, or null when all cash. */
  top: string | null;
}

export interface Board {
  top: BoardRow[];
  count: number;
  me: { rank: number; value: number } | null;
}

export interface PlayerResult {
  participantId: string;
  nickname: string;
  rank: number;
  of: number;
  value: number;
  bps: number;
  /** The purse the competition dealt; missing on results stored before it was recorded. */
  start?: number;
  cash: number;
  trades: number;
  best: { ticker: string; pnl: number } | null;
  worst: { ticker: string; pnl: number } | null;
  awards: string[];
  sessionId: string;
  finishedAt: number;
}

export interface Results {
  sessionId: string;
  top: PlayerResult[];
  awards: { id: string; label: string; nickname: string; detail: string }[];
  me: PlayerResult | null;
}

export type ServerMsg =
  | {
      t: 'hello';
      serverNow: number;
      you: { userId: string; nickname: string };
      session: SessionInfo | null;
      /** Tickers in the order every price array uses. */
      tickers: string[];
      /** The market's sequence number and time, and every price at it. */
      seq: number;
      at: number;
      prices: number[];
      /** Prices at the current (or last) competition's opening bell, for the change column. */
      open: number[];
      regime: Regime;
      /** Latest published news, newest first. */
      events: EventInfo[];
      book: BookInfo | null;
      /** Why there is no book: the session is full, or it already closed. */
      spectating: 'full' | 'closed' | null;
      board: Board;
      results: Results | null;
    }
  | { t: 'tick'; k: number; at: number; p: number[] }
  | { t: 'phase'; serverNow: number; session: SessionInfo; open: number[] }
  | { t: 'event'; ev: EventInfo }
  | { t: 'fund'; ticker: string; fund: Summary }
  | { t: 'regime'; regime: Regime }
  | { t: 'board'; board: Board }
  | { t: 'fill'; id: string; side: 'buy' | 'sell'; ticker: string; qty: number; price: number; total: number; realized: number; book: BookInfo; trade: TradeInfo }
  | { t: 'reject'; id: string; reason: RejectReason }
  | { t: 'results'; results: Results };

export type RejectReason =
  | 'insufficient_cash'
  | 'insufficient_shares'
  | 'invalid_quantity'
  | 'invalid_price'
  | 'market_closed'
  | 'not_in_session'
  | 'unknown_asset'
  | 'duplicate'
  | 'rate_limited'
  | 'bad_request'
  | 'server_error';

export type ClientMsg = { t: 'order'; id: string; side: 'buy' | 'sell'; ticker: string; qty: number };
