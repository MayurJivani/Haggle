// RealTime trading engine against a real Postgres, on a fixed clock and a scripted price feed (no network).
// Set TEST_DATABASE_URL as for engine.db.test.ts; a throwaway database is created and dropped. Skipped when unset.
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth.js';
import { connect, migrate, type Sql } from '../src/db/db.js';
import { MICRO } from '../src/realtime/ledger.js';
import type { Provider } from '../src/realtime/providers/provider.js';
import { Realtime } from '../src/realtime/service.js';
import type { Instrument, Quote } from '../src/realtime/types.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: 'silent' });

/** Tuesday 2026-11-24, 15:00Z: New York and Xetra open. */
const OPEN = Date.parse('2026-11-24T15:00:00Z');

describe.skipIf(!ADMIN_URL)('realtime trading against postgres', () => {
  const name = `haggle_rt_test_${Date.now()}`;
  let admin: Sql;
  let sql: Sql;
  let t = OPEN;
  const book = new Map<number, Quote>();
  let feedDown = false;
  const provider: Provider = {
    id: 'scripted', label: 'Scripted test feed', exchanges: ['US', 'XETRA'],
    covers: () => true,
    quality: () => ({ quality: 'realtime', delayMin: 0 }),
    quotes: async (list: Instrument[]) => {
      if (feedDown) throw new Error('feed down');
      return list.flatMap((i) => book.get(i.id) ?? []);
    },
    candles: async () => [],
  };
  const services: Realtime[] = [];
  const make = async () => {
    const rt = new Realtime(sql, log, {
      providers: [provider], startingCash: 10_000, tz: 'Europe/London', catalogueSync: false, tdKey: '', now: () => t, jobs: false,
      policy: { maxQuoteAgeMs: 60_000, slippageBps: 5, maxSpreadBps: 200, delayedFills: false, extendedHours: true, partialFills: true },
    });
    await rt.start();
    services.push(rt);
    return rt;
  };
  let rt: Realtime;
  let season: string;
  let aapl: number;
  let sap: number;
  let halted: number;

  const q = (id: number, p: Partial<Quote>): Quote => ({
    id, last: null, bid: null, ask: null, bidSize: null, askSize: null, open: null, high: null, low: null, prevClose: null, volume: null,
    at: t, quality: 'realtime', delayMin: 0, source: 'scripted', ...p,
  });
  const price = (id: number, last: number, extra: Partial<Quote> = {}) => {
    const quote = q(id, { last: last * 10_000, bid: (last - 0.01) * 10_000, ask: (last + 0.01) * 10_000, prevClose: last * 10_000, ...extra });
    book.set(id, quote);
    rt.market.inject(quote);
    return quote;
  };
  const player = async (nick: string) => {
    const { user } = (await createUser(sql, nick))!;
    await rt.trading.join(user.id, season);
    return user.id;
  };
  const buy = (user: string, id: number, shares: number, extra: object = {}) =>
    rt.trading.place(user, season, { clientOrderId: randomUUID(), instrumentId: id, side: 'buy', type: 'market', qty: shares * Number(MICRO), ...extra });
  const account = async (user: string) => (await sql<{ cash_cents: number; reserved_cents: number }[]>`
    SELECT cash_cents, reserved_cents FROM rt_accounts WHERE user_id = ${user} AND season_id = ${season}`)[0]!;
  const position = async (user: string, id: number) => (await sql<{ qty: number; reserved_qty: number; cost_cents: number; realized_cents: number }[]>`
    SELECT p.qty, p.reserved_qty, p.cost_cents, p.realized_cents FROM rt_positions p JOIN rt_accounts a ON a.id = p.account_id
    WHERE a.user_id = ${user} AND a.season_id = ${season} AND p.instrument_id = ${id}`)[0];

  beforeAll(async () => {
    admin = connect(ADMIN_URL!, 2);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${name}`;
    sql = connect(url.toString(), 20);
    await migrate(sql);
    const ids = await sql<{ id: number; symbol: string }[]>`
      INSERT INTO rt_instruments (symbol, mic, exchange, name, kind, currency, status) VALUES
        ('AAPL', 'XNGS', 'US', 'Apple Inc.', 'stock', 'USD', 'active'),
        ('SAP', 'XETR', 'XETRA', 'SAP SE', 'stock', 'EUR', 'active'),
        ('HALT', 'XNYS', 'US', 'Halted Corp', 'stock', 'USD', 'halted')
      RETURNING id, symbol`;
    [aapl, sap, halted] = ['AAPL', 'SAP', 'HALT'].map((s) => ids.find((r) => r.symbol === s)!.id) as [number, number, number];
    await sql`INSERT INTO rt_fx (currency, per_eur, as_of) VALUES ('USD', 1.25, '2026-11-24')`;
    rt = await make();
    season = (await rt.season('open'))!.id;
  });

  afterAll(async () => {
    for (const s of services) await s.stop().catch(() => {});
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it('fills a market buy at the ask in euro and books the ledger', async () => {
    t = OPEN;
    const u = await player('rt_buyer');
    price(aapl, 200);
    const r = await buy(u, aapl, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.execution!.price).toBe(2_000_100); // USD 200.01 ask
    expect(r.execution!.basis).toBe('ask');
    // 10 x 200.01 USD / 1.25 = EUR 1600.08
    expect(r.execution!.total).toBe(160_008);
    expect((await account(u)).cash_cents).toBe(1_000_000 - 160_008);
    expect(await position(u, aapl)).toEqual({ qty: 10_000_000, reserved_qty: 0, cost_cents: 160_008, realized_cents: 0 });
    const ledger = await rt.ledgerOf(u, season);
    expect(ledger.map((l) => [l.kind, l.amount, l.balanceAfter])).toEqual([['buy', -160_008, 839_992], ['grant', 1_000_000, 1_000_000]]);
  });

  it('sells at the bid and realises profit against the average cost', async () => {
    const u = await player('rt_seller');
    price(aapl, 200);
    await buy(u, aapl, 10);
    t += 1000;
    price(aapl, 250);
    const r = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'sell', type: 'market', qty: 4 * Number(MICRO) });
    if (!r.ok) throw new Error(r.reason);
    // 4 x 249.99 / 1.25 = 799.968 -> 79,996 cents; cost out 4/10 of 160,008 = 64,003.
    expect(r.execution!.total).toBe(79_996);
    expect(r.execution!.realized).toBe(79_996 - 64_003);
    const p = await position(u, aapl);
    expect(p).toEqual({ qty: 6_000_000, reserved_qty: 0, cost_cents: 160_008 - 64_003, realized_cents: 15_993 });
    const pf = (await rt.portfolio((await rt.accountFor(u, season))!))!;
    // Marked at last 250: 6 x 250 / 1.25 = EUR 1200.
    expect(pf.positions[0]!.value).toBe(120_000);
    expect(pf.unrealized).toBe(120_000 - 96_005);
    expect(pf.value).toBe(pf.cash + 120_000);
  });

  it('executes one order per client id, however often it is sent', async () => {
    const u = await player('rt_dup');
    price(aapl, 100);
    const id = randomUUID();
    const send = () => rt.trading.place(u, season, { clientOrderId: id, instrumentId: aapl, side: 'buy', type: 'market', qty: Number(MICRO) });
    const results = await Promise.all([send(), send(), send(), send()]);
    expect(results.every((r) => r.ok)).toBe(true);
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rt_executions e JOIN rt_orders o ON o.id = e.order_id WHERE o.client_order_id = ${id}`;
    expect(n!.n).toBe(1);
    expect((await position(u, aapl))!.qty).toBe(1_000_000);
  });

  it('never overspends when many orders race for the same cash', async () => {
    const u = await player('rt_race');
    price(aapl, 1000); // each share EUR ~800: 30% of the purse is 3.75 shares
    const results = await Promise.all(Array.from({ length: 12 }, () => buy(u, aapl, 4)));
    const filled = results.filter((r) => r.ok).length;
    expect(filled).toBe(3); // 3 x 4 x 1000.01 / 1.25 = EUR 9600.10; a 4th would need 12,800
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'insufficient_cash')).toBe(true);
    expect((await account(u)).cash_cents).toBeGreaterThanOrEqual(0);
    expect((await position(u, aapl))!.qty).toBe(12_000_000);
  });

  it('refuses insufficient cash and selling what is not held', async () => {
    const u = await player('rt_poor');
    price(aapl, 100);
    expect(await buy(u, aapl, 1000)).toEqual({ ok: false, reason: 'insufficient_cash' });
    const s = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'sell', type: 'market', qty: Number(MICRO) });
    expect(s).toEqual({ ok: false, reason: 'insufficient_shares' });
    expect((await account(u)).cash_cents).toBe(1_000_000);
  });

  it('buys by amount, in fractional shares', async () => {
    const u = await player('rt_frac');
    price(aapl, 300);
    const r = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'buy', type: 'market', amount: 10_000 });
    if (!r.ok) throw new Error(r.reason);
    // EUR 100 at USD 300.01 / 1.25: 0.416652 shares, costing at most EUR 100.
    expect(r.order.qty).toBe(416_652);
    expect(r.execution!.total).toBeLessThanOrEqual(10_000);
  });

  it('trades one second before the close and refuses one second after', async () => {
    const u = await player('rt_bell');
    t = Date.parse('2026-11-24T20:59:59Z');
    price(aapl, 100);
    expect((await buy(u, aapl, 1)).ok).toBe(true);
    t = Date.parse('2026-11-24T21:00:01Z');
    price(aapl, 100);
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'market_closed' });
    // A US stock is not tradable because Tokyo or London is.
    t = Date.parse('2026-11-25T01:30:00Z');
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'market_closed' });
    t = OPEN;
  });

  it('is closed on Thanksgiving and at the weekend', async () => {
    const u = await player('rt_holiday');
    t = Date.parse('2026-11-26T16:00:00Z');
    price(aapl, 100);
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'market_closed' });
    t = Date.parse('2026-11-28T16:00:00Z');
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'market_closed' });
    t = OPEN;
  });

  it('refuses a stale quote and keeps refusing while the feed is down', async () => {
    const u = await player('rt_stale');
    t = OPEN;
    price(aapl, 100);
    t = OPEN + 5 * 60_000;
    feedDown = true;
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'stale_quote' });
    feedDown = false;
    // The provider answers with the same old quote: still stale, never re-stamped.
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'stale_quote' });
    price(aapl, 100);
    expect((await buy(u, aapl, 1)).ok).toBe(true);
    t = OPEN;
  });

  it('refuses halted instruments and delayed data', async () => {
    const u = await player('rt_halt');
    price(halted, 50);
    expect(await buy(u, halted, 1)).toEqual({ ok: false, reason: 'halted' });
    price(aapl, 100, { halted: true });
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'halted' });
    price(aapl, 100, { quality: 'delayed', delayMin: 15 });
    expect(await buy(u, aapl, 1)).toEqual({ ok: false, reason: 'delayed_quote' });
    price(aapl, 100);
  });

  it('works a limit buy: reserves cash, fills partly on size, then fully, at the ask', async () => {
    const u = await player('rt_limit');
    price(aapl, 110);
    const r = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'buy', type: 'limit', qty: 10 * Number(MICRO), limitPrice: 1_000_000 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.order.status).toBe('open');
    const held = (await account(u)).reserved_cents;
    // 10 x 100 / 1.25 = 800 EUR plus 2% headroom for the exchange rate.
    expect(held).toBe(81_600);
    await rt.trading.settle();
    expect((await position(u, aapl))).toBeUndefined();

    t += 1000;
    price(aapl, 99.5, { askSize: 4 });
    await rt.trading.settle();
    let o = (await rt.ordersOf(u, season))[0]!;
    expect(o.status).toBe('partially_filled');
    expect(o.filledQty).toBe(4_000_000);
    // The same quote is not offered twice.
    rt.market.inject(book.get(aapl)!);
    await rt.trading.settle();
    expect((await rt.ordersOf(u, season))[0]!.filledQty).toBe(4_000_000);

    t += 1000;
    price(aapl, 99.5, { askSize: 100 });
    await rt.trading.settle();
    o = (await rt.ordersOf(u, season))[0]!;
    expect(o.status).toBe('filled');
    const acc = await account(u);
    expect(acc.reserved_cents).toBe(0);
    const p = (await position(u, aapl))!;
    expect(p.qty).toBe(10_000_000);
    expect(acc.cash_cents + p.cost_cents).toBe(1_000_000);
  });

  it('cancels a working order and gives back exactly what it held', async () => {
    const u = await player('rt_cancel');
    price(aapl, 100);
    await buy(u, aapl, 5);
    const sell = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'sell', type: 'limit', qty: 5 * Number(MICRO), limitPrice: 2_000_000 });
    if (!sell.ok) throw new Error(sell.reason);
    expect((await position(u, aapl))!.reserved_qty).toBe(5_000_000);
    // Shares promised to the limit sell cannot be sold again at market.
    const again = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'sell', type: 'market', qty: Number(MICRO) });
    expect(again).toEqual({ ok: false, reason: 'insufficient_shares' });
    const c = await rt.trading.cancel(u, sell.order.id);
    expect(c.ok && c.order.status).toBe('cancelled');
    expect((await position(u, aapl))!.reserved_qty).toBe(0);
    // Cancelling twice changes nothing; another player cannot cancel it at all.
    expect((await rt.trading.cancel(u, sell.order.id)).ok).toBe(true);
    const other = await player('rt_other');
    expect(await rt.trading.cancel(other, sell.order.id)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('queues a limit order while closed only when asked, and fills it in the next session', async () => {
    const u = await player('rt_queue');
    t = Date.parse('2026-11-28T16:00:00Z'); // Saturday
    const base = { instrumentId: aapl, side: 'buy' as const, type: 'limit' as const, qty: Number(MICRO), limitPrice: 1_200_000 };
    expect(await rt.trading.place(u, season, { ...base, clientOrderId: randomUUID() })).toEqual({ ok: false, reason: 'market_closed' });
    const r = await rt.trading.place(u, season, { ...base, clientOrderId: randomUUID(), queue: true });
    if (!r.ok) throw new Error(r.reason);
    expect(r.order.queued).toBe(true);
    // Weekend quotes do not fill it.
    price(aapl, 100);
    await rt.trading.settle();
    expect((await rt.ordersOf(u, season))[0]!.status).toBe('open');
    t = Date.parse('2026-11-30T14:30:05Z'); // Monday open
    price(aapl, 100);
    await rt.trading.settle();
    expect((await rt.ordersOf(u, season))[0]!.status).toBe('filled');
    t = OPEN;
  });

  it('keeps pending orders through a restart and fills them after', async () => {
    const u = await player('rt_restart');
    t = OPEN;
    price(sap, 150);
    const r = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: sap, side: 'buy', type: 'limit', qty: 2 * Number(MICRO), limitPrice: 1_400_000 });
    if (!r.ok) throw new Error(r.reason);
    await rt.stop();
    rt = await make();
    t += 1000;
    price(sap, 139);
    await rt.trading.settle();
    const o = (await rt.ordersOf(u, season)).find((x) => x.id === r.order.id)!;
    expect(o.status).toBe('filled');
    // SAP is in euro: 2 x 139.01 = EUR 278.02 exactly.
    expect((await position(u, sap))!.cost_cents).toBe(27_802);
  });

  it('applies a split once: four times the shares, the same cost, rescaled orders', async () => {
    const u = await player('rt_split');
    price(aapl, 400);
    await buy(u, aapl, 3);
    const before = (await position(u, aapl))!;
    const lim = await rt.trading.place(u, season, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'sell', type: 'limit', qty: Number(MICRO), limitPrice: 8_000_000 });
    if (!lim.ok) throw new Error(lim.reason);
    await sql`INSERT INTO rt_corporate_actions (instrument_id, kind, ex_date, ratio_from, ratio_to, source) VALUES (${aapl}, 'split', '2026-11-24', 1, 4, 'test')`;
    await rt.applyDueActions('2026-11-24');
    await rt.applyDueActions('2026-11-24');
    const after = (await position(u, aapl))!;
    expect(after.qty).toBe(before.qty * 4);
    expect(after.cost_cents).toBe(before.cost_cents);
    expect(after.reserved_qty).toBe(4_000_000);
    const o = (await rt.ordersOf(u, season)).find((x) => x.id === lim.order.id)!;
    expect([o.qty, o.limitPrice]).toEqual([4_000_000, 2_000_000]);
    await rt.trading.cancel(u, lim.order.id);
  });

  it('pays a dividend into cash and the ledger', async () => {
    const u = await player('rt_div');
    price(sap, 100);
    await buy(u, sap, 10);
    const cash = (await account(u)).cash_cents;
    await sql`INSERT INTO rt_corporate_actions (instrument_id, kind, ex_date, cash_amount, source) VALUES (${sap}, 'dividend', '2026-11-25', 22000, 'test')`;
    await rt.applyDueActions('2026-11-25');
    // 10 shares x EUR 2.20
    expect((await account(u)).cash_cents).toBe(cash + 2_200);
    expect((await rt.ledgerOf(u, season))[0]!.kind).toBe('dividend');
  });

  it('closes registration on time and settles the standing at the end', async () => {
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO rt_seasons (slug, name, kind, starting_cash_cents, starts_at, ends_at, join_until, rules, status)
      VALUES ('test-week', 'Test week', 'weekly', 500000, ${new Date(OPEN - 3600_000)}, ${new Date(OPEN + 3600_000)}, ${new Date(OPEN - 60_000)}, 'test', 'active')
      RETURNING id`;
    const { user } = (await createUser(sql, 'rt_late'))!;
    expect(await rt.trading.join(user.id, s!.id)).toEqual({ ok: false, reason: 'season_closed' });
    await sql`UPDATE rt_seasons SET join_until = ${new Date(OPEN + 60_000)} WHERE id = ${s!.id}`;
    expect((await rt.trading.join(user.id, s!.id)).ok).toBe(true);
    price(aapl, 100);
    const r = await rt.trading.place(user.id, s!.id, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'buy', type: 'market', qty: Number(MICRO) });
    expect(r.ok).toBe(true);
    t = OPEN + 3600_000;
    await rt.settleDue();
    const res = await rt.results(s!.id);
    expect(res).toHaveLength(1);
    expect(res[0]!.rank).toBe(1);
    price(aapl, 100);
    const later = await rt.trading.place(user.id, s!.id, { clientOrderId: randomUUID(), instrumentId: aapl, side: 'buy', type: 'market', qty: Number(MICRO) });
    expect(later).toEqual({ ok: false, reason: 'season_closed' });
  });

  it('ranks the leaderboard by value and keeps private holdings private', async () => {
    const rows = await rt.board(season, 'value', 100, true);
    expect(rows.length).toBeGreaterThan(5);
    for (let k = 1; k < rows.length; k++) expect(rows[k - 1]!.value).toBeGreaterThanOrEqual(rows[k]!.value);
    const someone = rows[0]!.userId;
    const view = await rt.player(someone, season, null);
    expect(view!.positions).toBeNull();
    await rt.setProfile(someone, true, []);
    expect((await rt.player(someone, season, null))!.positions).not.toBeNull();
  });

  it('keeps the books balanced: cash plus cost equals the purse plus realised gains', async () => {
    const rows = await sql<{ id: string; cash_cents: number; reserved_cents: number; starting_cash_cents: number }[]>`
      SELECT id, cash_cents, reserved_cents, starting_cash_cents FROM rt_accounts`;
    for (const a of rows) {
      const [p] = await sql<{ cost: number; realized: number }[]>`
        SELECT coalesce(sum(cost_cents), 0)::bigint AS cost, coalesce(sum(realized_cents), 0)::bigint AS realized FROM rt_positions WHERE account_id = ${a.id}`;
      expect(a.cash_cents + p!.cost).toBe(a.starting_cash_cents + p!.realized);
      const [o] = await sql<{ held: number }[]>`SELECT coalesce(sum(reserved_cents), 0)::bigint AS held FROM rt_orders WHERE account_id = ${a.id} AND status IN ('open', 'partially_filled')`;
      expect(a.reserved_cents).toBe(o!.held);
      const [l] = await sql<{ bal: number }[]>`SELECT balance_after_cents AS bal FROM rt_ledger WHERE account_id = ${a.id} ORDER BY id DESC LIMIT 1`;
      expect(l!.bal).toBe(a.cash_cents);
    }
  });
});
