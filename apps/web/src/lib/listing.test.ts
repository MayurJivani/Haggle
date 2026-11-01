import { describe, expect, it, vi } from 'vitest';
import type { AssetInfo, EventInfo, ServerMsg } from '../../../server/src/protocol';
import { concernsListing, game } from './game';

const asset = (ticker: string, sector: string) => ({ ticker, name: ticker, sector, fund: {} }) as unknown as AssetInfo;
vi.stubGlobal('fetch', async (url: string) =>
  new Response(JSON.stringify(url.startsWith('/api/market') ? { assets: [asset('AAA', 'Energy'), asset('BBB', 'Media'), asset('CCC', 'Energy')] } : { trades: [] })));
const receive = (m: ServerMsg) => (game as unknown as { receive(m: ServerMsg): void }).receive(m);
const story = (id: number, over: Partial<EventInfo>) => ({ id, sessionId: 's', seq: 1, at: 0, category: 'company', scope: 'asset', target: null, related: [], headline: '', body: '', figures: [], severity: 1, ...over }) as EventInfo;

describe('a competition that lists part of the market', () => {
  it('shows only its companies, with every price array lined up with them', async () => {
    receive({
      t: 'hello', serverNow: Date.now(), you: { userId: 'u', nickname: 'me' }, session: null, tickers: ['AAA', 'BBB', 'CCC'], listed: ['AAA', 'CCC'], sectors: ['Energy'],
      seq: 1, at: 0, prices: [100, 200, 300], open: [90, 190, 290], regime: 'calm', credit: 2,
      events: [story(1, { target: 'AAA', related: ['AAA'] }), story(2, { target: 'BBB', related: ['BBB'] })], book: null, spectating: null, board: { top: [], count: 0, me: null, at: 0 }, results: null,
    });
    await vi.waitFor(() => expect(game.get().assets.map((a) => a.ticker)).toEqual(['AAA', 'CCC']));
    expect(game.get().index.get('CCC')).toBe(1);
    expect(game.get().prices).toEqual([100, 300]);
    expect(game.get().open).toEqual([90, 290]);
    expect(game.get().events.map((e) => e.id)).toEqual([1]);

    receive({ t: 'tick', k: 2, at: 1, p: [101, 201, 301] });
    expect(game.get().prices).toEqual([101, 301]);
    expect(game.ticks.at(-1)!.p).toEqual([101, 301]);
    receive({ t: 'event', ev: story(3, { target: 'BBB', related: ['BBB'] }) });
    expect(game.get().events.map((e) => e.id)).toEqual([1]);
    expect(game.get().unread).toBe(0);
  });

  it('keeps the economy, its own sectors and stories naming its companies, and nothing else', () => {
    const tickers = new Set(['AAA']);
    const sectors = new Set(['Energy']);
    const keep = (o: Partial<EventInfo>) => concernsListing(story(1, o), tickers, sectors);
    expect(keep({ scope: 'market', related: ['ZZZ'] })).toBe(true);
    expect(keep({ scope: 'factor', target: 'oil' })).toBe(true);
    expect(keep({ scope: 'sector', target: 'Energy' })).toBe(true);
    expect(keep({ scope: 'sector', target: 'Media' })).toBe(false);
    expect(keep({ scope: 'basket', related: ['ZZZ', 'AAA'] })).toBe(true);
    expect(keep({ scope: 'basket', related: ['ZZZ'] })).toBe(false);
    expect(keep({ scope: 'asset', target: 'ZZZ', related: ['ZZZ'] })).toBe(false);
  });
});
