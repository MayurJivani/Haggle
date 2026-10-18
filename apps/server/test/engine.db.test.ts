// Integration test against a real Postgres: concurrency, duplicates, ledger consistency, restart
// recovery and the close. Set TEST_DATABASE_URL to any database the user may CREATE DATABASE from;
// a throwaway database is created and dropped around the run. Skipped when unset.
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, migrate, type Sql } from '../src/db/db.js';
import type { ServerMsg } from '../src/protocol.js';
import { Engine, type Client } from '../src/session/engine.js';

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
    engines.forEach((e) => e.stop());
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
    engine.stop();
  });

  it('runs a whole session with consistent books', async () => {
    const engine = new Engine(sql, config, log);
    engines.push(engine);
    await engine.start();
    const alice = await makeClient('alice');
    const bob = await makeClient('bob');
    await engine.attach(alice.client);
    await engine.attach(bob.client);
    expect(alice.inbox[0]).toMatchObject({ t: 'hello', book: { cash: 100_000 } });

    // Lobby: trading is refused.
    await engine.order(alice.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 1 });
    expect(rejects(alice.inbox).at(-1)?.reason).toBe('market_closed');

    expect(await engine.openNow()).toBe(true);
    await sleep(300);

    // 40 concurrent buys of a ~EUR 60 stock: only as many as the cash covers may fill.
    await Promise.all(Array.from({ length: 40 }, () => engine.order(alice.client, { t: 'order', id: randomUUID(), side: 'buy', ticker: 'KO', qty: 1 })));
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
      expect(b.spent + 100_000).toBe(b.cash_cents);
      expect(b.cash_cents).toBeGreaterThanOrEqual(0);
    }
    const lastAlice = fills(alice.inbox).at(-1) as Extract<ServerMsg, { t: 'fill' }>;
    const aliceDb = books.find((b) => b.id === lastAlice.book.participantId)!;
    expect(lastAlice.book.cash).toBe(aliceDb.cash_cents);

    // A second engine on the same database (a restart) rebuilds the identical tape and books.
    engine.stop();
    const tick = engine.live!.sim.tick;
    const prices = Array.from(engine.live!.history.map((h) => h[tick]!));
    const restarted = new Engine(sql, config, log);
    engines.push(restarted);
    await restarted.start();
    expect(Array.from(restarted.live!.history.map((h) => h[tick]!))).toEqual(prices);
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
    const [session] = await sql<{ status: string; closing_prices: Record<string, number> }[]>`SELECT status, closing_prices FROM sessions`;
    expect(session!.status).toBe('finished');
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
  });
});
