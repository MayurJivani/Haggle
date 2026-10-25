import { describe, expect, it, vi } from 'vitest';
import type { AssetInfo, ServerMsg } from '../../../server/src/protocol';
import { game } from './game';
import { valuation } from './portfolio';

const asset = (ticker: string): AssetInfo => ({
  ticker, name: ticker, exchange: 'X', sector: 'Energy', industry: 'Oil', description: '', beta: 1, risk: 'low',
  fund: { epsTtm: null, revenueTtm: null, netIncomeTtm: null, epsGrowth: null, revenueGrowth: null, latest: null, fair: null },
} as unknown as AssetInfo);

// The store's network calls, answered locally: the listing, and an empty trade history.
vi.stubGlobal('fetch', async (url: string) =>
  new Response(JSON.stringify(url.startsWith('/api/market') ? { assets: [asset('AAA'), asset('BBB')] } : { trades: [] })));

const receive = (m: ServerMsg) => (game as unknown as { receive(m: ServerMsg): void }).receive(m);
const book = (cash: number, positions: { ticker: string; qty: number; cost: number; realized: number }[]) => ({ participantId: 'p', cash, positions, trades: positions.length });
const session = {
  id: 's', phase: 'trading' as const, opensAt: 0, closingAt: 0, closesAt: 0, nextAt: null, tick: 1, totalTicks: 10, tickMs: 1000, players: 1, maxPlayers: 5,
  startingCash: 1_000_000, room: null,
};
const now = () => valuation(game.get(), game.get().session!.startingCash);

describe('portfolio state after a trade', () => {
  it('updates cash, the position and P/L from the fill alone, then follows live prices', async () => {
    receive({
      t: 'hello', serverNow: Date.now(), you: { userId: 'u', nickname: 'me' }, session, tickers: ['AAA', 'BBB'], seq: 1, at: 0, prices: [10_000, 5_000],
      open: [10_000, 5_000], regime: 'calm', events: [], book: book(1_000_000, []), spectating: null, board: { top: [], count: 1, me: null, at: 0 }, results: null,
    });
    await vi.waitFor(() => expect(game.get().assets).toHaveLength(2));
    expect(now()).toMatchObject({ value: 1_000_000, pnl: 0, invested: 0 });

    // Buy 10 AAA at EUR 100: no refresh, no refetch, just the server's fill.
    const trade = { id: 1, at: 0, ticker: 'AAA', side: 'buy' as const, qty: 10, price: 10_000, total: 100_000, realized: 0 };
    receive({ t: 'fill', id: 'o1', side: 'buy', ticker: 'AAA', qty: 10, price: 10_000, total: 100_000, realized: 0, book: book(900_000, [{ ticker: 'AAA', qty: 10, cost: 100_000, realized: 0 }]), trade });
    expect(now()).toMatchObject({ cash: 900_000, invested: 100_000, value: 1_000_000, unrealized: 0, pnl: 0 });
    expect(game.get().trades).toEqual([trade]);

    // A live tick moves AAA to EUR 110: unrealised and total P/L follow.
    receive({ t: 'tick', k: 2, at: 1000, p: [11_000, 5_000] });
    expect(now()).toMatchObject({ value: 1_010_000, unrealized: 10_000, pnl: 10_000, bps: 100 });
    expect(now().byTicker.get('AAA')).toMatchObject({ qty: 10, value: 110_000, unrealized: 10_000 });

    // Selling 4 realises (110 - 100) x 4 = EUR 40 into cash; the value is not counted twice.
    receive({
      t: 'fill', id: 'o2', side: 'sell', ticker: 'AAA', qty: 4, price: 11_000, total: 44_000, realized: 4_000,
      book: book(944_000, [{ ticker: 'AAA', qty: 6, cost: 60_000, realized: 4_000 }]), trade: { ...trade, id: 2, side: 'sell', qty: 4, price: 11_000, total: 44_000, realized: 4_000 },
    });
    expect(now()).toMatchObject({ cash: 944_000, invested: 66_000, value: 1_010_000, unrealized: 6_000, realized: 4_000, pnl: 10_000 });
  });
});
