// Integration test against a real Postgres: concurrency, duplicates, ledger consistency, restart
// recovery and the close. Set TEST_DATABASE_URL to any database the user may CREATE DATABASE from;
// a throwaway database is created and dropped around the run. Skipped when unset.
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, migrate, type Sql } from '../src/db/db.js';
import type { ServerMsg } from '../src/protocol.js';
import { Engine, type Client } from '../src/session/engine.js';
import { STARTING_CASH } from '../src/trading/portfolio.js';
import { ASSETS } from '../src/market/assets.js';
import { seedReports, summarize } from '../src/market/fundamentals.js';
import { MarketSim, type MarketState } from '../src/market/sim.js';
import { liveEvents } from '../src/session/store.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ADMIN_URL)('engine against postgres', () => {
  const name = `haggle_test_${Date.now()}`;
  let admin: Sql;
  let sql: Sql;
  const engines: Engine[] = [];

  const config = { lobbySeconds: 600, tradingSeconds: 4, closingSeconds: 1, resultsSeconds: 600, tickMs: 250, maxPlayers: 3, seed: 777 };

  const makeClient = async (nickname: string) => {
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (nickname, token_hash) VALUES (${nickname}, ${Buffer.from(randomUUID())}) RETURNING id`;
    const inbox: ServerMsg[] = [];
    const client: Client = { userId: u!.id, nickname, send: (d) => inbox.push(JSON.parse(d)) };
    return { client, inbox };
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
    const id = engines[0]!.live!.row.id;
    await sql`UPDATE sessions SET opens_at = now() - interval '1 hour', closes_at = now() - interval '50 minutes' WHERE id = ${id}`;
    const engine = new Engine(sql, config, log);
    engines.push(engine);
    await engine.start();
    await sleep(300);
    expect(engine.live!.row.id).toBe(id);
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
    const rebuilt = new MarketSim(ASSETS, cp!.state, fairs);
    rebuilt.load((await liveEvents(sql, cp!.state.seq, ASSETS)).map((e) => ({ ...e, effects: e.effects })));
    rebuilt.advanceTo(stoppedSeq);
    expect(Array.from(rebuilt.prices)).toEqual(stoppedPrices);

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
      SELECT count(*)::int AS n, min(seq) AS lo, max(seq) AS hi FROM market_prices WHERE session_id = ${session!.id} AND ticker = 'KO'`;
    expect([span!.n, span!.hi - span!.lo + 1, span!.lo]).toEqual([ticks, ticks, session!.start_seq + 1]);
    // News landed on schedule and nothing was left waiting.
    const statuses = await sql<{ status: string; published_at: Date | null }[]>`SELECT status, published_at FROM market_events WHERE session_id = ${session!.id}`;
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((e) => e.status === 'published' && e.published_at)).toBe(true);
    // Final value recomputed from the stored closing prices matches the stored result.
    const pos = await sql<{ participant_id: string; ticker: string; quantity: number }[]>`SELECT participant_id, ticker, quantity FROM positions`;
    for (const b of books) {
      const [r] = await sql<{ final_value_cents: number }[]>`SELECT final_value_cents FROM results WHERE participant_id = ${b.id}`;
      const [cash] = await sql<{ cash_cents: number }[]>`SELECT cash_cents FROM participants WHERE id = ${b.id}`;
      const held = pos.filter((p) => p.participant_id === b.id).reduce((s, p) => s + p.quantity * session!.closing_prices[p.ticker]!, 0);
      expect(r!.final_value_cents).toBe(cash!.cash_cents + held);
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
    const id = engine.live!.row.id;
    const [row] = await sql<{ closing_prices: Record<string, number> }[]>`SELECT closing_prices FROM sessions WHERE id = ${id}`;
    expect(row!.closing_prices.SAP).toBe(bellPrices[ASSETS.findIndex((a) => a.ticker === 'SAP')]);
    const [head] = await sql<{ seq: number }[]>`SELECT max(seq) AS seq FROM market_checkpoints`;
    expect(head!.seq).toBe(bellSeq);
    // Stories that had not landed by the early bell are cancelled, never carried over.
    const left = await sql`SELECT 1 FROM market_events WHERE session_id = ${id} AND status = 'scheduled'`;
    expect(left).toHaveLength(0);
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
});
