// Wire format shared with apps/web (type-only import). Money is integer cents, returns are basis points.
// Nothing here carries an event's price impact, a company's event sensitivities or an unpublished
// story: clients see what happened, never what the market will do about it.

import type { Category, Figure, Scope, Source } from './market/events.js';
import type { Report, Summary } from './market/fundamentals.js';

export type { Category, Figure, Report, Scope, Source, Summary };

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
  /** Null for the house competition that loops by itself. */
  room: RoomInfo | null;
}

export interface RoomSettings {
  /** The bell waits for the host instead of a clock. */
  manualStart: boolean;
  /** Players may join after the bell. */
  lateJoin: boolean;
  /** Participants may inspect each other's portfolios while trading. */
  peek: boolean;
  /** Every portfolio is shown on the results page. */
  reveal: boolean;
  /** A private room's results are visible outside it. */
  publicResults: boolean;
}

export interface RoomInfo {
  code: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  hostId: string | null;
  host: string | null;
  settings: RoomSettings;
  /** How many companies the room lists. */
  companies: number;
}

/** GET /api/rooms: public rooms still open to join or watch. */
export interface RoomListing {
  code: string;
  name: string;
  host: string | null;
  phase: Phase;
  players: number;
  maxPlayers: number;
  startingCash: number;
  opensAt: number;
  closesAt: number;
  manualStart: boolean;
  companies: number;
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
  /** In the house listing; the others are only offered to custom rooms. */
  core: boolean;
  /** What kind of company it is, in the units the price model uses. */
  traits: { growth: number; cyclical: number; speculation: number; debt: number; oil: number; defensive: boolean };
  fund: Summary;
}

/** GET /api/market: the listing, which changes only when a company reports. */
export interface MarketInfo {
  assets: AssetInfo[];
}

/** GET /api/floor: the main market at a glance, for the home page. Same for every visitor. */
export interface FloorInfo {
  /** The main market's listing against its prices one round's worth of ticks ago, in listing order. */
  quotes: { ticker: string; sector: string; price: number; bps: number }[];
  /** Latest stories about the main market, newest first. */
  news: EventInfo[];
  /** How long each part of a main-market round runs, in seconds. */
  round: { lobby: number; trading: number; closing: number; results: number };
}

/** One published story. */
export interface EventInfo {
  id: number;
  /** The competition that scheduled it, on stories from before the shared schedule. */
  sessionId: string | null;
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
  /** How solid the story is. Missing on stories from before reliability was recorded. */
  source?: Source;
  /** On an earnings story: EPS against what was expected, and what management said next. */
  earnings?: { actual: number; expected: number; guidance?: 'raised' | 'held' | 'cut' };
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

/**
 * GET /api/index?range=&sector=: the equal-weighted index of the whole listing or one sector, as bars in
 * hundredths of a point. `base` is each member's first recorded price, so a client folds live ticks
 * into exactly the levels the server computed.
 */
export interface IndexHistory extends PriceHistory {
  base: Record<string, number>;
}

/** GET /api/activity: executed trades per company in the current competition. */
export interface Activity {
  sessionId: string | null;
  rows: { ticker: string; trades: number; shares: number; turnover: number }[];
}

/**
 * GET /api/reactions: what the tape did after each recent story, measured from the tick before it
 * landed. `settled` once the window has passed or the competition closed; until then it runs to now.
 */
export interface Reaction {
  id: number;
  subject: 'market' | 'sector' | 'company';
  bps: number;
  /** Ticks the move covers so far. */
  ticks: number;
  settled: boolean;
  /** Per company, for company news only (sector and market reactions are averages over many). */
  moves: { ticker: string; bps: number }[];
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

/** One trader on a leaderboard. Holdings are worth value - cash; profit is value - startingCash. */
export interface BoardRow {
  rank: number;
  participantId: string;
  nickname: string;
  value: number;
  cash: number;
  bps: number;
  trades: number;
  /** Ticker of the player's largest holding by value, or null when all cash. */
  top: string | null;
}

export interface Board {
  top: BoardRow[];
  count: number;
  me: BoardRow | null;
  /** Server time the ranking was valued at: every row uses the prices of that one moment. */
  at: number;
}

/** GET /api/sessions/:id/board: every trader, ranked at one valuation time. */
export interface FullBoard {
  rows: BoardRow[];
  at: number;
}

/** One trader's book, valued at the given prices (the results page and the in-game peek). */
export interface PortfolioView {
  participantId: string;
  nickname: string;
  cash: number;
  holdings: HoldingResult[];
}

/** A position at a given price: shares still held (0 when sold out), their cost, realised profit, the price. */
export interface HoldingResult {
  ticker: string;
  qty: number;
  cost: number;
  realized: number;
  close: number;
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
  /**
   * Every company the player traded, at the closing prices: shares still held (0 when sold out), the
   * cost of those shares, profit already realised, and the closing price. Missing on older results.
   */
  holdings?: HoldingResult[];
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
  /** Whether other traders' holdings are published (a room may keep them private). */
  portfolios: boolean;
  /** A private room's results, withheld from someone who did not play in it. */
  restricted: boolean;
}

export type ServerMsg =
  | {
      t: 'hello';
      serverNow: number;
      you: { userId: string; nickname: string };
      session: SessionInfo | null;
      /** Tickers in the order every price array uses. */
      tickers: string[];
      /** The companies this competition lists: a client shows these and only these. */
      listed: string[];
      /** The sectors those companies belong to. */
      sectors: string[];
      /** The market's sequence number and time, and every price at it. */
      seq: number;
      at: number;
      prices: number[];
      /** Prices at the current (or last) competition's opening bell, for the change column. */
      open: number[];
      regime: Regime;
      /** Corporate credit spread in percentage points: what companies pay over government debt. */
      credit: number;
      /** Latest published news, newest first. */
      events: EventInfo[];
      book: BookInfo | null;
      /** Why there is no book: the competition is full, already closed, or past the bell in a room without late joining. */
      spectating: 'full' | 'closed' | 'late' | null;
      board: Board;
      results: Results | null;
    }
  | { t: 'tick'; k: number; at: number; p: number[] }
  | { t: 'phase'; serverNow: number; session: SessionInfo; open: number[] }
  | { t: 'event'; ev: EventInfo }
  | { t: 'fund'; ticker: string; fund: Summary }
  | { t: 'regime'; regime: Regime; credit: number }
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
