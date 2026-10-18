// Simulated-client load test: N real players join over HTTP, hold a WebSocket each, trade at random,
// replay some orders on purpose, drop and reconnect a slice of themselves mid-run, and check what
// came back. Run against a live server; see LOADTEST.md.
//
//   TARGET=http://localhost:4371 CLIENTS=500 DURATION=120 ADMIN_TOKEN=... npm run loadtest
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { BookInfo, ServerMsg } from '../src/protocol.js';

const TARGET = process.env.TARGET ?? 'http://localhost:4371';
const CLIENTS = Number(process.env.CLIENTS ?? 500);
const DURATION = Number(process.env.DURATION ?? 120) * 1000;
const ORDER_EVERY_MS = Number(process.env.ORDER_EVERY_MS ?? 4000);
const DUPLICATE_RATE = Number(process.env.DUPLICATE_RATE ?? 0.05);
const RECONNECT_FRACTION = Number(process.env.RECONNECT_FRACTION ?? 0.1);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const run = Date.now().toString(36).slice(-5);
const origin = new URL(TARGET).origin;
const wsUrl = TARGET.replace(/^http/, 'ws') + '/ws';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);

const stats = {
  joined: 0,
  connected: 0,
  helloMs: [] as number[],
  orderMs: [] as number[],
  fills: 0,
  rejects: {} as Record<string, number>,
  dupesSent: 0,
  dupesExecutedTwice: 0,
  reconnects: 0,
  reconnectMismatch: 0,
  errors: 0,
  tickArrivals: new Map<number, number[]>(),
};

interface Bot {
  i: number;
  cookie: string;
  ws: WebSocket | null;
  book: BookInfo | null;
  tickers: string[];
  prices: number[];
  sent: Map<string, number>;
  filledIds: Set<string>;
  open: boolean;
}

async function join(i: number): Promise<Bot> {
  const res = await fetch(`${TARGET}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ nickname: `bot-${run}-${i}` }),
  });
  if (!res.ok) throw new Error(`join ${i}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  stats.joined++;
  return { i, cookie, ws: null, book: null, tickers: [], prices: [], sent: new Map(), filledIds: new Set(), open: false };
}

function connect(bot: Bot): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ws = new WebSocket(wsUrl, { headers: { cookie: bot.cookie, origin } });
    bot.ws = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      if (m.t === 'hello') {
        stats.helloMs.push(Date.now() - started);
        bot.tickers = m.assets.map((a) => a.ticker);
        bot.prices = m.history.prices.map((p) => p.at(-1)!);
        bot.book = m.book;
        bot.open = m.session?.phase === 'trading' || m.session?.phase === 'closing';
        resolve();
      } else if (m.t === 'tick') {
        bot.prices = m.p;
        const arr = stats.tickArrivals.get(m.k) ?? [];
        arr.push(Date.now());
        stats.tickArrivals.set(m.k, arr);
      } else if (m.t === 'phase') {
        bot.open = m.session.phase === 'trading' || m.session.phase === 'closing';
      } else if (m.t === 'fill') {
        if (bot.filledIds.has(m.id)) stats.dupesExecutedTwice++;
        bot.filledIds.add(m.id);
        const t = bot.sent.get(m.id);
        if (t) stats.orderMs.push(Date.now() - t);
        bot.sent.delete(m.id);
        bot.book = m.book;
        stats.fills++;
      } else if (m.t === 'reject') {
        stats.rejects[m.reason] = (stats.rejects[m.reason] ?? 0) + 1;
        const t = bot.sent.get(m.id);
        if (t) stats.orderMs.push(Date.now() - t);
        bot.sent.delete(m.id);
      }
    });
    ws.on('open', () => stats.connected++);
    ws.on('close', () => stats.connected--);
    ws.on('error', (err) => {
      stats.errors++;
      reject(err);
    });
  });
}

function trade(bot: Bot) {
  if (!bot.open || !bot.book || bot.ws?.readyState !== WebSocket.OPEN) return;
  const owned = bot.book.positions.filter((p) => p.qty > 0);
  const sell = owned.length > 0 && Math.random() < 0.4;
  let msg;
  if (sell) {
    const p = owned[Math.floor(Math.random() * owned.length)]!;
    msg = { t: 'order', id: randomUUID(), side: 'sell', ticker: p.ticker, qty: 1 + Math.floor(Math.random() * p.qty) };
  } else {
    const i = Math.floor(Math.random() * bot.tickers.length);
    const qty = Math.max(1, Math.floor((bot.book.cash * Math.random() * 0.3) / (bot.prices[i] ?? 1e9)));
    msg = { t: 'order', id: randomUUID(), side: 'buy', ticker: bot.tickers[i]!, qty };
  }
  bot.sent.set(msg.id, Date.now());
  const data = JSON.stringify(msg);
  bot.ws.send(data);
  if (Math.random() < DUPLICATE_RATE) {
    stats.dupesSent++;
    bot.ws.send(data);
  }
}

async function main() {
  console.log(`load test: ${CLIENTS} clients against ${TARGET} for ${DURATION / 1000}s`);
  const bots: Bot[] = [];
  for (let i = 0; i < CLIENTS; i += 25) {
    bots.push(...(await Promise.all(Array.from({ length: Math.min(25, CLIENTS - i) }, (_, k) => join(i + k)))));
  }
  console.log(`joined ${stats.joined}`);
  for (let i = 0; i < bots.length; i += 50) await Promise.all(bots.slice(i, i + 50).map(connect));
  console.log(`connected ${stats.connected}, hello p95 ${pct(stats.helloMs, 95)}ms`);

  if (ADMIN_TOKEN) {
    const r = await fetch(`${TARGET}/api/admin/start`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    console.log(`admin start: ${r.status}`);
  }

  const timers = bots.map((b) => setInterval(() => trade(b), ORDER_EVERY_MS * (0.5 + Math.random())));

  // Mid-run: drop a slice of clients, reconnect them, and check the server restored the same book.
  await sleep(DURATION / 2);
  const slice = bots.slice(0, Math.floor(bots.length * RECONNECT_FRACTION));
  await Promise.all(
    slice.map(async (b) => {
      b.ws?.terminate();
      await sleep(500);
      // Let in-flight orders settle so the book we compare against is final.
      const before = b.book ? JSON.stringify({ cash: b.book.cash, positions: b.book.positions }) : null;
      await connect(b);
      stats.reconnects++;
      const after = b.book ? JSON.stringify({ cash: b.book.cash, positions: b.book.positions }) : null;
      if (before !== after && b.sent.size === 0) stats.reconnectMismatch++;
    }),
  );

  await sleep(DURATION / 2);
  timers.forEach(clearInterval);
  await sleep(1500);
  bots.forEach((b) => b.ws?.close());

  const skews = [...stats.tickArrivals.values()].filter((a) => a.length > CLIENTS * 0.5).map((a) => Math.max(...a) - Math.min(...a));
  const report = {
    clients: CLIENTS,
    joined: stats.joined,
    fills: stats.fills,
    rejects: stats.rejects,
    orderLatencyMs: { p50: pct(stats.orderMs, 50), p95: pct(stats.orderMs, 95), p99: pct(stats.orderMs, 99) },
    helloMs: { p50: pct(stats.helloMs, 50), p95: pct(stats.helloMs, 95) },
    tickFanoutSkewMs: { p50: pct(skews, 50), p95: pct(skews, 95), ticks: skews.length },
    duplicates: { sent: stats.dupesSent, executedTwice: stats.dupesExecutedTwice },
    reconnects: { done: stats.reconnects, bookMismatches: stats.reconnectMismatch },
    socketErrors: stats.errors,
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = stats.dupesExecutedTwice === 0 && stats.reconnectMismatch === 0 && stats.joined === CLIENTS && !stats.rejects.server_error;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
