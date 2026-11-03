// Integration test against a real Postgres: concurrency, duplicates, ledger consistency, restart
// recovery and the close. Set TEST_DATABASE_URL to any database the user may CREATE DATABASE from;
// a throwaway database is created and dropped around the run. Skipped when unset.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE, createUser } from '../src/auth.js';
import { connect, migrate, type Sql } from '../src/db/db.js';
import type { Env } from '../src/env.js';
import type { Replay, ServerMsg } from '../src/protocol.js';
import { Engine, HOUSE, type Client } from '../src/session/engine.js';
import { STARTING_CASH } from '../src/trading/portfolio.js';
import { ASSETS, CORE_TICKERS } from '../src/market/assets.js';
import { seedReports, summarize } from '../src/market/fundamentals.js';
import { initialState, type MarketState } from '../src/market/sim.js';
import { ENGINE_VERSION, Tape } from '../src/market/tape.js';
import { foldOldPrices, liveEvents, loadReports, priceBars } from '../src/session/store.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SEED = 4242;
const log = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ADMIN_URL)('engine against postgres', () => {
  const name = `haggle_test_${Date.now()}`;
  let admin: Sql;
  let sql: Sql;
  const engines: Engine[] = [];

  const config = { lobbySeconds: 600, tradingSeconds: 4, closingSeconds: 1, resultsSeconds: 600, tickMs: 250, maxPlayers: 3, maxRooms: 5, marketSeed: SEED, tickRetentionDays: 30 };

  const makeClient = async (nickname: string, room = HOUSE) => {
    const { user, token } = (await createUser(sql, nickname))!;
    const inbox: ServerMsg[] = [];
    const client: Client = { userId: user.id, nickname, room, send: (d) => inbox.push(JSON.parse(d)) };
    return { client, inbox, token };
  };
  const fills = (inbox: ServerMsg[]) => inbox.filter((m) => m.t === 'fill');
  const rejects = (inbox: ServerMsg[]) => inbox.filter((m): m is Extract<ServerMsg, { t: 'reject' }> => m.t === 'reject');

  beforeAll(async () => {
    admin = connect(ADMIN_URL!, 2);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${name}`;
    sql = connect(url.toString());
    await migrate(sql);
  });

  afterAll(async () => {
    await Promise.all(engines.map((e) => e.stop()));
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it('keeps an empty lobby waiting instead of opening the market', async () => {
    const engine = new Engine(sql, config, log);
    engines.push(engine);
    await engine.start();
    expect(await engine.openNow()).toBe(true);
    await sleep(300);
    const s = engine.sessionInfo()!;
    expect(s.phase).toBe('lobby');
    expect(s.opensAt).toBeGreaterThan(Date.now());
    // Nobody traded, so the shared market did not move.
    expect(engine.market.seq).toBe(0);
    await engine.stop();
  });

  it('lets only one process own the market', async () => {
    const owner = new Engine(sql, config, log);
    engines.push(owner);
    await owner.start();
    await expect(new Engine(sql, config, log).start()).rejects.toThrow(/owns this market/);
    await owner.stop();
  });

  it('does not replay a lobby whose bell time passed while the server was down', async () => {
    const id = engines[0]!.house!.row.id;
    await sql`UPDATE sessions SET opens_at = now() - interval '1 hour', closes_at = now() - interval '50 minutes' WHERE id = ${id}`;
    const engine = new Engine(sql, config, log);
    engines.push(engine);
    await engine.start();
    await sleep(300);
    expect(engine.house!.row.id).toBe(id);
    expect(engine.sessionInfo()!.tick).toBe(0);
    expect(engine.sessionInfo()!.phase).toBe('lobby');
    expect(engine.sessionInfo()!.opensAt).toBeGreaterThan(Date.now());
    await engine.stop();
  });

  it('runs a whole session with consistent books', async () => {
    const engine = new Engine(sql, config, log);
    engines.push(engine);
    await engine.start();
    const alice = await makeClient('alice');
    const bob = await makeClient('bob');
    await engine.attach(alice.client);
    await engine.attach(bob.client);
    expect(alice.inbox[0]).toMatchObject({ t: 'hello', book: { cash: STARTING_CASH } });

    // Lobby: trading is refused.
    await engine.order(alice.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 1 });
    expect(rejects(alice.inbox).at(-1)?.reason).toBe('market_closed');

    expect(await engine.openNow()).toBe(true);
    await sleep(300);

    // 40 concurrent buys of 5 KO (~EUR 300 each, ~EUR 12,000 in all): only as many as the cash covers may fill.
    await Promise.all(Array.from({ length: 40 }, () => engine.order(alice.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 5 })));
    const filled = fills(alice.inbox).length;
    expect(filled).toBeGreaterThan(5);
    expect(filled + rejects(alice.inbox).filter((r) => r.reason === 'insufficient_cash').length).toBe(40);

    // The same client order id five times at once executes once.
    const dup = randomUUID();
    await Promise.all(Array.from({ length: 5 }, () => engine.order(bob.client, { t: 'order', id: dup, side: 'buy', ticker: 'SAP', qty: 2 })));
    expect(fills(bob.inbox)).toHaveLength(1);
    expect(rejects(bob.inbox).filter((r) => r.reason === 'duplicate')).toHaveLength(4);

    // Selling more than owned, and an unknown ticker, are refused.
    await engine.order(bob.client, { t: 'order', id: randomUUID(), side: 'sell', ticker: 'SAP', qty: 3 });
    await engine.order(bob.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'NOPE', qty: 1 });
    expect(rejects(bob.inbox).slice(-2).map((r) => r.reason)).toEqual(['insufficient_shares', 'unknown_asset']);
    await engine.order(bob.client, { t: 'order', id: randomUUID(), side: 'sell', ticker: 'SAP', qty: 1 });
    expect(fills(bob.inbox)).toHaveLength(2);

    // Database and memory agree, and the ledger sums to the cash balance for everyone.
    const books = await sql<{ id: string; cash_cents: number; ledger: number; spent: number }[]>`
      SELECT p.id, p.cash_cents,
        (SELECT sum(amount_cents)::bigint FROM ledger l WHERE l.participant_id = p.id) AS ledger,
        (SELECT coalesce(sum(CASE WHEN side = 'buy' THEN -total_cents ELSE total_cents END), 0)::bigint FROM trades t WHERE t.participant_id = p.id) AS spent
      FROM participants p`;
    for (const b of books) {
      expect(b.ledger).toBe(b.cash_cents);
      expect(b.spent + STARTING_CASH).toBe(b.cash_cents);
      expect(b.cash_cents).toBeGreaterThanOrEqual(0);
    }
    const lastAlice = fills(alice.inbox).at(-1) as Extract<ServerMsg, { t: 'fill' }>;
    const aliceDb = books.find((b) => b.id === lastAlice.book.participantId)!;
    expect(lastAlice.book.cash).toBe(aliceDb.cash_cents);

    // A restart: the next engine resumes from the last checkpoint and replays the ticks after it.
    // Rebuilding the market from what is stored reproduces the stopped engine's prices exactly.
    await engine.stop();
    const stoppedSeq = engine.market.seq;
    const stoppedPrices = Array.from(engine.market.prices);
    const [cp] = await sql<{ state: MarketState }[]>`SELECT state FROM market_checkpoints WHERE seq <= ${stoppedSeq} ORDER BY seq DESC LIMIT 1`;
    const fairs = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
    const stored = await loadReports(sql);
    const rebuilt = new Tape(ASSETS, cp!.state, fairs, ASSETS.map((a) => stored.filter((x) => x.ticker === a.ticker)), SEED);
    rebuilt.load(await liveEvents(sql, cp!.state.seq, ASSETS));
    while (rebuilt.sim.seq < stoppedSeq) { rebuilt.prepare(); rebuilt.step(); }
    expect(Array.from(rebuilt.sim.prices)).toEqual(stoppedPrices);

    const restarted = new Engine(sql, config, log);
    engines.push(restarted);
    await restarted.start();
    expect(restarted.market.seq).toBeGreaterThanOrEqual(stoppedSeq);
    const again = { client: { ...alice.client, send: (d: string) => alice.inbox.push(JSON.parse(d)) }, inbox: alice.inbox };
    await restarted.attach(again.client);
    const hello = alice.inbox.at(-1) as Extract<ServerMsg, { t: 'hello' }>;
    expect(hello.book?.cash).toBe(aliceDb.cash_cents);

    // The bell closes the market and ranks everyone at the same closing prices.
    await sleep(config.tradingSeconds * 1000 + 800);
    const results = alice.inbox.find((m) => m.t === 'results') as Extract<ServerMsg, { t: 'results' }>;
    expect(results).toBeDefined();
    const rows = await sql<{ rank: number; final_value_cents: number }[]>`SELECT rank, final_value_cents FROM results ORDER BY rank`;
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]!.final_value_cents).toBeGreaterThanOrEqual(rows[1]!.final_value_cents);
    const [session] = await sql<{ id: string; status: string; closing_prices: Record<string, number>; start_seq: number; config: { startingCash: number } }[]>`
      SELECT id, status, closing_prices, start_seq, config FROM sessions WHERE status = 'finished' ORDER BY finished_at DESC LIMIT 1`;
    expect(session!.status).toBe('finished');
    expect(session!.config.startingCash).toBe(STARTING_CASH);
    // Every tick of the competition is stored once per company: no gaps, no invented points.
    const ticks = Math.floor((config.tradingSeconds * 1000) / config.tickMs);
    const [span] = await sql<{ n: number; lo: number; hi: number }[]>`
      SELECT count(*)::int AS n, min(seq) AS lo, max(seq) AS hi FROM market_prices WHERE seq > ${session!.start_seq} AND seq <= ${session!.start_seq + ticks} AND ticker = 'KO'`;
    expect([span!.n, span!.hi - span!.lo + 1, span!.lo]).toEqual([ticks, ticks, session!.start_seq + 1]);
    // News landed on schedule and nothing was left waiting.
    const statuses = await sql<{ status: string; published_at: Date | null }[]>`SELECT status, published_at FROM market_events WHERE market_seq > ${session!.start_seq} AND market_seq <= ${session!.start_seq + ticks}`;
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((e) => e.status === 'published' && e.published_at)).toBe(true);
    // Every company without an earnings story filed its quarter quietly: stored as a report, never as news.
    const [quiet] = await sql<{ n: number; filed: number }[]>`
      SELECT count(*)::int AS n, (SELECT count(*)::int FROM financial_reports f JOIN market_events e ON e.id = f.event_id
        WHERE e.template = 'quiet-report') AS filed
      FROM market_events WHERE template = 'quiet-report' AND status = 'published'`;
    expect(quiet!.n).toBeGreaterThan(0);
    expect(quiet!.filed).toBe(quiet!.n);
    const news = (alice.inbox.filter((m) => m.t === 'hello').at(-1) as Extract<ServerMsg, { t: 'hello' }>).events;
    expect(news.some((e) => / files Q\d FY\d+ results$/.test(e.headline))).toBe(false);
    // Final value recomputed from the stored closing prices matches the stored result.
    const pos = await sql<{ participant_id: string; ticker: string; quantity: number }[]>`SELECT participant_id, ticker, quantity FROM positions`;
    for (const b of books) {
      const [r] = await sql<{ final_value_cents: number }[]>`SELECT final_value_cents FROM results WHERE participant_id = ${b.id}`;
      const [cash] = await sql<{ cash_cents: number }[]>`SELECT cash_cents FROM participants WHERE id = ${b.id}`;
      const held = pos.filter((p) => p.participant_id === b.id).reduce((s, p) => s + p.quantity * session!.closing_prices[p.ticker]!, 0);
      expect(r!.final_value_cents).toBe(cash!.cash_cents + held);
      // The published portfolio matches the books and adds up to the final value.
      const [row] = await sql<{ stats: { holdings: { ticker: string; qty: number; close: number }[] } }[]>`SELECT stats FROM results WHERE participant_id = ${b.id}`;
      const stats = row!.stats;
      const mine = pos.filter((p) => p.participant_id === b.id && p.quantity > 0);
      expect(stats.holdings.filter((h) => h.qty > 0).map((h) => [h.ticker, h.qty]).sort()).toEqual(mine.map((p) => [p.ticker, p.quantity]).sort());
      expect(stats.holdings.every((h) => h.close === session!.closing_prices[h.ticker])).toBe(true);
      expect(cash!.cash_cents + stats.holdings.reduce((sum, h) => sum + h.qty * h.close, 0)).toBe(r!.final_value_cents);
    }
    // After the bell nothing executes.
    await restarted.order(again.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 1 });
    expect(rejects(alice.inbox).at(-1)?.reason).toBe('market_closed');
    await restarted.stop();
  });

  it('lets the host close the market early and start the next round', async () => {
    const engine = new Engine(sql, config, log);
    engines.push(engine);
    await engine.start();
    expect(engine.nextNow()).toBe(false); // nothing to skip in a lobby
    const carol = await makeClient('carol');
    await engine.attach(carol.client);
    expect(await engine.openNow()).toBe(true);
    await sleep(700);
    // Buying hard does not move the price: the market is the same tape with or without orders.
    await engine.order(carol.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'SAP', qty: 3 });
    expect(fills(carol.inbox)).toHaveLength(1);
    expect(await engine.closeNow()).toBe(true);
    const bellSeq = engine.market.seq;
    const bellPrices = Array.from(engine.market.prices);
    await sleep(400);
    expect(engine.sessionInfo()!.phase).toBe('results');
    expect(carol.inbox.some((m) => m.t === 'results')).toBe(true);
    expect(engine.market.seq).toBe(bellSeq);
    // Closing prices are the prices at the moment the host rang the bell, and they are durable.
    const id = engine.house!.row.id;
    const [row] = await sql<{ closing_prices: Record<string, number> }[]>`SELECT closing_prices FROM sessions WHERE id = ${id}`;
    expect(row!.closing_prices.SAP).toBe(bellPrices[ASSETS.findIndex((a) => a.ticker === 'SAP')]);
    const [head] = await sql<{ seq: number }[]>`SELECT max(seq) AS seq FROM market_checkpoints`;
    expect(head!.seq).toBe(bellSeq);
    // Stories that had not landed by the early bell stay on the tape: a room closing never changes the market.
    const left = await sql`SELECT 1 FROM market_events WHERE market_seq > ${bellSeq} AND status = 'scheduled'`;
    expect(left.length).toBeGreaterThan(0);
    expect(await engine.closeNow()).toBe(false);
    // Skipping the results screen deals carol into a fresh lobby.
    expect(engine.nextNow()).toBe(true);
    await sleep(400);
    expect(engine.sessionInfo()!.phase).toBe('lobby');
    expect(engine.sessionInfo()!.id).not.toBe(id);
    expect(engine.sessionInfo()!.players).toBe(1);
    // The next competition opens on the last one's closing prices, with a fresh purse.
    expect(await engine.openNow()).toBe(true);
    await sleep(400);
    const [next] = await sql<{ opening_prices: Record<string, number>; start_seq: number }[]>`SELECT opening_prices, start_seq FROM sessions WHERE id = ${engine.sessionInfo()!.id}`;
    expect(next!.start_seq).toBe(bellSeq);
    expect(ASSETS.map((a) => next!.opening_prices[a.ticker])).toEqual(bellPrices);
    const hello = carol.inbox.filter((m) => m.t === 'hello').at(-1) as Extract<ServerMsg, { t: 'hello' }>;
    expect(hello.book?.cash).toBe(STARTING_CASH);
    expect(hello.prices).toEqual(bellPrices);
  });

  it('runs custom rooms side by side on one shared market, each with its own books and frozen results', async () => {
    await Promise.all(engines.map((e) => e.stop()));
    const engine = new Engine(sql, { ...config, lobbySeconds: 3600 }, log);
    engines.push(engine);
    await engine.start();
    const room = (over: Partial<Parameters<Engine['createRoom']>[1]>) => ({
      name: 'Room', description: null, visibility: 'public' as const, maxPlayers: 5, startingCash: 500_000, durationSeconds: 2, startAt: null,
      lateJoin: true, peek: false, reveal: true, publicResults: false, tickers: CORE_TICKERS, ...over,
    });
    const hostA = await makeClient('host a');
    const hostB = await makeClient('host b');
    const a = await engine.createRoom({ id: hostA.client.userId, nickname: 'host a' }, room({ name: 'Short', tickers: ['KO', 'PEP', 'NFLX', 'ORCL', 'ZAL'] }));
    const b = await engine.createRoom({ id: hostB.client.userId, nickname: 'host b' }, room({ name: 'Long', visibility: 'private', durationSeconds: 4, lateJoin: false }));
    if ('error' in a || 'error' in b) throw new Error('room refused');
    const roomA = engine.liveByCode(a.code)!;
    const roomB = engine.liveByCode(b.code)!;
    expect(engine.listRooms().map((r) => r.code)).toEqual([a.code]); // private rooms are not listed

    const dana = await makeClient('dana', roomA.row.id);
    const danaInB = { client: { ...dana.client, room: roomB.row.id, send: (d: string) => danaB.push(JSON.parse(d)) } };
    const danaB: ServerMsg[] = [];
    await engine.attach(dana.client);
    await engine.attach(dana.client); // a second tab: still one seat and one purse
    await engine.attach(danaInB.client);
    hostA.client.room = roomA.row.id;
    hostB.client.room = roomB.row.id;
    await engine.attach(hostA.client);
    await engine.attach(hostB.client);
    const [row0] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM participants WHERE user_id = ${dana.client.userId}`;
    expect(row0!.n).toBe(2);
    expect(dana.inbox[0]).toMatchObject({ t: 'hello', book: { cash: 500_000 }, session: { room: { code: a.code, name: 'Short' } } });

    // Only the host rings a manual bell, and the room waits for it.
    expect(engine.isHost(roomA, hostA.client.userId)).toBe(true);
    expect(engine.isHost(roomA, dana.client.userId)).toBe(false);
    await sleep(300);
    expect([roomA.startSeq, roomA.phase]).toEqual([null, 'lobby']);
    expect(await engine.openNow(roomA)).toBe(true);
    await sleep(600);
    expect(await engine.openNow(roomB)).toBe(true);
    await sleep(400);
    // Both rooms trade one tape on one tick grid.
    expect(roomB.startSeq).toBeGreaterThan(roomA.startSeq!);
    expect((roomB.opensAt - roomA.opensAt) % config.tickMs).toBe(0);

    // Books are per room: dana's buy in A leaves her purse in B untouched.
    await engine.order(dana.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 10 });
    expect(fills(dana.inbox)).toHaveLength(1);
    expect(fills(danaB)).toHaveLength(0);
    expect(engine.portfolioOf(roomB, engine.participantOf(dana.client.userId, roomB.row.id)!)!.cash).toBe(500_000);
    // A room trades what it lists, and only that: ZAL here, NVDA nowhere near it, and ZAL is not in B's core listing.
    expect(dana.inbox[0]).toMatchObject({ t: 'hello', listed: ['ORCL', 'NFLX', 'ZAL', 'KO', 'PEP'].sort((x, y) => ASSETS.findIndex((a) => a.ticker === x) - ASSETS.findIndex((a) => a.ticker === y)) });
    await engine.order(dana.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'ZAL', qty: 1 });
    expect(fills(dana.inbox).at(-1)?.ticker).toBe('ZAL');
    await engine.order(dana.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'NVDA', qty: 1 });
    expect(rejects(dana.inbox).at(-1)?.reason).toBe('unknown_asset');
    await engine.order(danaInB.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'ZAL', qty: 1 });
    expect(rejects(danaB).at(-1)?.reason).toBe('unknown_asset');
    // B allows no late joiners: someone arriving after its bell watches.
    const late = await makeClient('late', roomB.row.id);
    await engine.attach(late.client);
    expect(late.inbox[0]).toMatchObject({ t: 'hello', book: null, spectating: 'late' });
    await engine.order(late.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 1 });
    expect(rejects(late.inbox).at(-1)?.reason).toBe('not_in_session');
    // B is private: its board and results are for its own traders.
    expect(engine.canView(roomB, dana.client.userId)).toBe(true);
    expect(engine.canView(roomB, hostA.client.userId)).toBe(false);
    expect(engine.canView(roomA, late.client.userId)).toBe(true);

    // A closes while B keeps the market running; A's results stay on its own closing tick.
    await sleep(2200);
    const resA = dana.inbox.find((m) => m.t === 'results') as Extract<ServerMsg, { t: 'results' }>;
    expect(resA).toBeDefined();
    expect(roomB.finishedAt).toBeNull();
    const endA = roomA.startSeq! + roomA.cfg.totalTicks;
    const [stored] = await sql<{ closing_prices: Record<string, number> }[]>`SELECT closing_prices FROM sessions WHERE id = ${roomA.row.id}`;
    const atEnd = await sql<{ ticker: string; price_cents: number }[]>`SELECT ticker, price_cents FROM market_prices WHERE seq = ${endA}`;
    expect(Object.fromEntries(atEnd.map((r) => [r.ticker, r.price_cents]))).toEqual(stored!.closing_prices);
    const before = (await sql<{ final_value_cents: number }[]>`SELECT final_value_cents FROM results WHERE session_id = ${roomA.row.id} ORDER BY rank`).map((r) => r.final_value_cents);
    await sleep(800);
    expect(engine.market.seq).toBeGreaterThan(endA);
    const after = (await sql<{ final_value_cents: number }[]>`SELECT final_value_cents FROM results WHERE session_id = ${roomA.row.id} ORDER BY rank`).map((r) => r.final_value_cents);
    expect(after).toEqual(before);
    expect(engine.fullBoard(roomA).rows.map((r) => r.value)).toEqual(before);
    // Every trader in A appears in its results, including the one who never traded.
    expect(resA.results.top.map((r) => r.nickname).sort()).toEqual(['dana', 'host a']);
    // A room's results stay in the room: nothing reaches the main market's roster or results.
    const house = engine.house!;
    expect(engine.fullBoard(house).rows.map((r) => r.nickname)).not.toContain('dana');
    const [leak] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM results r JOIN participants p ON p.id = r.participant_id WHERE r.session_id = ${house.row.id} AND p.user_id = ${dana.client.userId}`;
    expect(leak!.n).toBe(0);
    expect(resA.results.top.find((r) => r.nickname === 'host a')).toMatchObject({ trades: 0, holdings: [], value: 500_000 });

    await sleep(2000);
    expect(danaB.some((m) => m.t === 'results')).toBe(true);
    // Once both rooms are done the market stops.
    const stopped = engine.market.seq;
    await sleep(500);
    expect(engine.market.seq).toBe(stopped);
    // An outsider who reaches the finished private room by its code sees no results.
    const nosy = await makeClient('nosy', roomB.row.id);
    await engine.attach(nosy.client);
    expect(nosy.inbox[0]).toMatchObject({ t: 'hello', results: { restricted: true, top: [] } });

    // The replay keeps the results' visibility: B's race is for B's traders only, A's is for anyone.
    // app.ts reads the environment as it loads (through the logger), so it comes in only when this suite runs.
    process.env.DATABASE_URL ??= ADMIN_URL;
    const { createApp } = await import('../src/app.js');
    const server = createApp(sql, engine, { TRUST_PROXY: false, ALLOWED_ORIGINS: [], JOIN_RATE_LIMIT: 1000, ADMIN_TOKEN: '', MAX_PLAYERS: 50 } as unknown as Env).listen(0);
    const replayOf = (id: string, token?: string) =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${id}/replay`, token ? { headers: { cookie: `${COOKIE}=${token}` } } : {});
    try {
      expect((await replayOf(roomB.row.id)).status).toBe(403);
      expect((await replayOf(roomB.row.id, nosy.token)).status).toBe(403);
      const later = await engine.createRoom({ id: hostA.client.userId, nickname: 'host a' }, room({ name: 'Later' }));
      if ('error' in later) throw new Error('room refused');
      expect((await replayOf(engine.liveByCode(later.code)!.row.id)).status).toBe(404); // no race before the bell
      expect((await replayOf(roomA.row.id)).status).toBe(200);
      const res = await replayOf(roomB.row.id, dana.token);
      expect(res.headers.get('cache-control')).toMatch(/^private/);
      const race = (await res.json()) as Replay;
      // From the bell to the close in order, each line in final rank order and ending on the final value.
      expect(race.ticks[0]).toBe(0);
      expect(race.ticks).toEqual([...race.ticks].sort((x, y) => x - y));
      expect(race.ticks.at(-1)).toBe(roomB.cfg.totalTicks);
      expect(race.ticks.length).toBeGreaterThan(2);
      const finals = await sql<{ participant_id: string; rank: number; final_value_cents: number }[]>`
        SELECT participant_id, rank, final_value_cents FROM results WHERE session_id = ${roomB.row.id} ORDER BY rank`;
      expect(race.players.map((p) => [p.participantId, p.rank, p.values.at(-1), p.ranks.at(-1)])).toEqual(finals.map((f) => [f.participant_id, f.rank, f.final_value_cents, f.rank]));
      for (const p of race.players) expect(p.values[0]).toBe(500_000);
      expect(race.players.every((p) => p.values.every((v) => v !== null))).toBe(true);
      expect(race.news.every((n) => n.tick > 0 && n.tick <= roomB.cfg.totalTicks && (n.severity >= 2 || n.market))).toBe(true);
    } finally {
      server.close();
    }
    await engine.stop();
  });

  it('rooms never touched the tape: everything stored is what a market with no rooms plays', async () => {
    // Competitions opened, closed early, overlapped and survived a restart above. None of it may show here.
    const stored = await sql<{ seq: number; ticker: string; price_cents: number }[]>`SELECT seq, ticker, price_cents FROM market_prices ORDER BY seq`;
    const fairs = ASSETS.map((a) => summarize(a, seedReports(a)).fair!.cents);
    const pure = new Tape(ASSETS, initialState(ASSETS, SEED, fairs), fairs, ASSETS.map((a) => seedReports(a)), SEED);
    const bySeq = new Map<number, Map<string, number>>();
    for (const r of stored) {
      const seq = Number(r.seq);
      if (!bySeq.has(seq)) bySeq.set(seq, new Map());
      bySeq.get(seq)!.set(r.ticker, r.price_cents);
    }
    expect(bySeq.size).toBeGreaterThan(30);
    const last = Math.max(...bySeq.keys());
    const planned = [];
    while (pure.sim.seq < last) {
      planned.push(...pure.prepare());
      pure.step();
      const row = bySeq.get(pure.sim.seq);
      if (row) expect(ASSETS.map((a) => row.get(a.ticker))).toEqual(Array.from(pure.sim.prices));
    }
    const events = await sql<{ id: string; headline: string; engine_version: string }[]>`SELECT id, headline, engine_version FROM market_events WHERE market_seq <= ${last} AND id > 0 ORDER BY id`;
    expect(events.map((e) => [Number(e.id), e.headline])).toEqual(planned.map((e) => [e.id, e.headline]).sort((a, b) => (a[0] as number) - (b[0] as number)).filter(([id]) => events.some((e) => Number(e.id) === id)));
    expect(events.every((e) => e.engine_version === ENGINE_VERSION)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it('folds old ticks into minute bars without losing the chart or anything a live game needs', async () => {
    const [{ n: before }] = (await sql`SELECT count(*)::int AS n FROM market_prices`) as unknown as [{ n: number }];
    const [{ hi }] = (await sql`SELECT max(seq) AS hi FROM market_prices`) as unknown as [{ hi: string }];
    const keep = Number(hi) - 5;
    const bars = async () => (await priceBars(sql, 'KO', new Date(0), 3_600_000));
    const chart = await bars();
    let folded = 0;
    // Twice with a small batch: a minute split across batches must merge into one correct bar.
    for (let k = 0; k < 2; k++) folded += await foldOldPrices(sql, new Date(Date.now() + 86_400_000), keep, 700);
    expect(folded).toBe(Math.min(1400, before));
    const [{ n: after }] = (await sql`SELECT count(*)::int AS n FROM market_prices`) as unknown as [{ n: number }];
    expect(after).toBe(before - folded);
    const left = await sql`SELECT 1 FROM market_prices WHERE seq >= ${keep}`;
    expect(left.length).toBeGreaterThan(0);
    const now = await bars();
    expect(now.map((b) => [b.at, b.o, b.h, b.l, b.c, b.seq])).toEqual(chart.map((b) => [b.at, b.o, b.h, b.l, b.c, b.seq]));
    // A retention window that has not passed touches nothing.
    expect(await foldOldPrices(sql, new Date(0), keep, 700)).toBe(0);
  });
});
