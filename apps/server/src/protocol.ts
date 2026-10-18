// Wire format shared with apps/web (type-only import). Money is integer cents, returns are basis points.

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
}

export interface AssetInfo {
  ticker: string;
  name: string;
  sector: string;
  description: string;
  base: number;
  vol: number;
  beta: number;
  sens: Record<string, number>;
}

export interface EventInfo {
  seq: number;
  tick: number;
  template: string;
  scope: 'asset' | 'sector' | 'market' | 'factor';
  target: string | null;
  headline: string;
  description: string;
  severity: 1 | 2 | 3;
  duration: number;
  effects: { ticker: string; bps: number }[];
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
      assets: AssetInfo[];
      /** Price history every `step` ticks, one array per asset in asset order, ending at the current tick. */
      history: { step: number; prices: number[][] };
      events: EventInfo[];
      book: BookInfo | null;
      /** Why there is no book: the session is full, or it already closed. */
      spectating: 'full' | 'closed' | null;
      board: Board;
      results: Results | null;
    }
  | { t: 'tick'; k: number; p: number[] }
  | { t: 'phase'; serverNow: number; session: SessionInfo }
  | { t: 'event'; ev: EventInfo }
  | { t: 'board'; board: Board }
  | { t: 'fill'; id: string; side: 'buy' | 'sell'; ticker: string; qty: number; price: number; total: number; realized: number; book: BookInfo }
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
