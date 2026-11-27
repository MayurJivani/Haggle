// Simulated-client load test: N real players join over HTTP, hold a WebSocket each, trade at random,
// replay some orders on purpose, open price charts and company pages the way players research, drop
// and reconnect a slice of themselves mid-run, and check what came back: no order executed twice, the
// same book after a reconnect, and every story reaching every player. See HOW-IT-WORKS.md.
//
//   TARGET=http://localhost:4371 CLIENTS=500 DURATION=120 ADMIN_TOKEN=... npm run loadtest
//   ROOMS=10 splits the clients across that many custom rooms; RECOVER=1 reconnects through a server restart.
//   ROOM=CODE puts every client in a room someone already opened (an /event), for its host to start.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { BookInfo, EventScreen, ServerMsg } from '../src/protocol.js';

const TARGET = process.env.TARGET ?? 'http://localhost:4371';
const CLIENTS = Number(process.env.CLIENTS ?? 500);
const DURATION = Number(process.env.DURATION ?? 120) * 1000;
const ORDER_EVERY_MS = Number(process.env.ORDER_EVERY_MS ?? 4000);
const DUPLICATE_RATE = Number(process.env.DUPLICATE_RATE ?? 0.05);
const RECONNECT_FRACTION = Number(process.env.RECONNECT_FRACTION ?? 0.1);
const RESEARCH_EVERY_MS = Number(process.env.RESEARCH_EVERY_MS ?? 15000);
const RANGES = ['1m', '5m', '15m', '1h', 'all'];
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ROOMS = Number(process.env.ROOMS ?? 0);
const ROOM = process.env.ROOM ?? null;
const RECOVER = process.env.RECOVER === '1';
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
  /** Which bots saw each published story. */
  eventArrivals: new Map<number, Set<number>>(),
  researchMs: [] as number[],
  researchErrors: 0,
  /** Every socket's prices per tick: rooms share one tape, so any disagreement is a bug. */
  tickPrices: new Map<number, string>(),
  inconsistentTicks: 0,
  /** A fill in a ticker the bot's room does not list, or for an order it never sent. */
  crossRoom: 0,
  outages: 0,
  /** The event TV polled by each room's host: latency, and screens whose head count or order was wrong. */
  screenMs: [] as number[],
  screenErrors: 0,
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
  room: string | null;
  picks: number[];
  reconnecting?: boolean;
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
  return { i, cookie, ws: null, book: null, tickers: [], prices: [], sent: new Map(), filledIds: new Set(), open: false, room: null, picks: [] };
}

function connect(bot: Bot): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ws = new WebSocket(bot.room ? `${wsUrl}?room=${bot.room}` : wsUrl, { headers: { cookie: bot.cookie, origin } });
    bot.ws = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      if (m.t === 'hello') {
        stats.helloMs.push(Date.now() - started);
        bot.tickers = m.listed;
        bot.picks = m.listed.map((t) => m.tickers.indexOf(t));
        bot.prices = bot.picks.map((i) => m.prices[i]!);
        bot.book = m.book;
        bot.open = m.session?.phase === 'trading' || m.session?.phase === 'closing';
        resolve();
      } else if (m.t === 'tick') {
        bot.prices = bot.picks.map((i) => m.p[i]!);
        const fp = m.p.join();
        const seen = stats.tickPrices.get(m.k);
        if (seen === undefined) stats.tickPrices.set(m.k, fp);
        else if (seen !== fp) stats.inconsistentTicks++;
        const arr = stats.tickArrivals.get(m.k) ?? [];
        arr.push(Date.now());
        stats.tickArrivals.set(m.k, arr);
      } else if (m.t === 'event') {
        const seen = stats.eventArrivals.get(m.ev.id) ?? new Set<number>();
        seen.add(bot.i);
        stats.eventArrivals.set(m.ev.id, seen);
      } else if (m.t === 'phase') {
        bot.open = m.session.phase === 'trading' || m.session.phase === 'closing';
      } else if (m.t === 'fill') {
        if (bot.filledIds.has(m.id)) stats.dupesExecutedTwice++;
        if (!bot.tickers.includes(m.ticker) || !bot.sent.has(m.id)) stats.crossRoom++;
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
    ws.on('close', () => {
      stats.connected--;
      // Through a restart: keep trying with the same cookie, and the book must come back.
      if (RECOVER && bot.ws === ws && !bot.reconnecting) { stats.outages++; bot.open = false; void reconnectLoop(bot); }
    });
    ws.on('error', (err) => {
      if (!RECOVER) stats.errors++;
      reject(err);
    });
  });
}

async function reconnectLoop(bot: Bot) {
  bot.reconnecting = true;
  for (let k = 0; k < 120; k++) {
    await sleep(1000 + Math.random() * 1000);
    try { await connect(bot); bot.reconnecting = false; return; } catch { /* still down */ }
  }
  stats.errors++;
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

/** A player opening a chart or a company page: the same requests the web client makes. */
async function research(bot: Bot) {
  if (!bot.tickers.length) return;
  const ticker = bot.tickers[Math.floor(Math.random() * bot.tickers.length)]!;
  const url = Math.random() < 0.7
    ? `${TARGET}/api/prices/${ticker}?range=${RANGES[Math.floor(Math.random() * RANGES.length)]}`
    : `${TARGET}/api/companies/${ticker}`;
  const t = Date.now();
  try {
    const r = await fetch(url, { headers: { cookie: bot.cookie } });
    await r.arrayBuffer();
    if (!r.ok && !RECOVER) stats.researchErrors++;
    stats.researchMs.push(Date.now() - t);
  } catch {
    if (!RECOVER) stats.researchErrors++;
  }
}

async function main() {
  console.log(`load test: ${CLIENTS} clients against ${TARGET} for ${DURATION / 1000}s`);
  const bots: Bot[] = [];
  for (let i = 0; i < CLIENTS; i += 25) {
    bots.push(...(await Promise.all(Array.from({ length: Math.min(25, CLIENTS - i) }, (_, k) => join(i + k)))));
  }
  console.log(`joined ${stats.joined}`);
  const hosts: { code: string; cookie: string }[] = [];
  for (let k = 0; k < ROOMS; k++) {
    const host = bots[Math.floor((k * bots.length) / ROOMS)]!;
    const r = await fetch(`${TARGET}/api/rooms`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, cookie: host.cookie },
      body: JSON.stringify({ name: `Load ${k}`, maxPlayers: Math.ceil(CLIENTS / ROOMS) + 1, durationMinutes: Math.ceil(DURATION / 60000) + 2 }),
    });
    if (!r.ok) throw new Error(`room ${k}: ${r.status} ${await r.text()}`);
    hosts.push({ code: ((await r.json()) as { code: string }).code, cookie: host.cookie });
  }
  if (ROOMS) bots.forEach((b, i) => (b.room = hosts[i % ROOMS]!.code));
  if (ROOM) bots.forEach((b) => (b.room = ROOM));
  for (let i = 0; i < bots.length; i += 50) await Promise.all(bots.slice(i, i + 50).map(connect));
  console.log(`connected ${stats.connected}, hello p95 ${pct(stats.helloMs, 95)}ms`);

  for (const h of hosts) {
    const r = await fetch(`${TARGET}/api/rooms/${h.code}/start`, { method: 'POST', headers: { origin, cookie: h.cookie } });
    if (!r.ok) throw new Error(`start ${h.code}: ${r.status}`);
  }
  if (hosts.length) console.log(`${hosts.length} rooms opened`);
  if (ADMIN_TOKEN && !ROOMS && !ROOM) {
    const r = await fetch(`${TARGET}/api/admin/start`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    console.log(`admin start: ${r.status}`);
  }

  // Each room's host keeps its event screen open, as a TV would.
  const watchScreen = async (h: { code: string; cookie: string }) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${TARGET}/api/rooms/${h.code}/screen`, { headers: { cookie: h.cookie } });
      const v = (await r.json()) as EventScreen;
      stats.screenMs.push(Date.now() - t0);
      const sorted = v.top.every((row, i) => i === 0 || v.top[i - 1]!.value >= row.value);
      if (!r.ok || v.count !== bots.filter((b) => b.room === h.code).length || !sorted || v.lines.length !== Math.min(8, v.count)) stats.screenErrors++;
    } catch {
      if (!RECOVER) stats.screenErrors++;
    }
  };
  const timers = [
    ...hosts.map((h) => setInterval(() => void watchScreen(h), 2000)),
    ...bots.map((b) => setInterval(() => trade(b), ORDER_EVERY_MS * (0.5 + Math.random()))),
    ...bots.map((b) => setInterval(() => void research(b), RESEARCH_EVERY_MS * (0.5 + Math.random()))),
  ];

  // Mid-run: drop a slice of clients, reconnect them, and check the server restored the same book.
  await sleep(DURATION / 2);
  // A recovery run has its own outage: a deliberate drop as well would connect some bots twice.
  const slice = RECOVER ? [] : bots.slice(0, Math.floor(bots.length * RECONNECT_FRACTION));
  await Promise.all(
    slice.map(async (b) => {
      b.ws?.terminate();
      await sleep(500);
      // Let in-flight orders settle so the book we compare against is final.
      const before = b.book ? JSON.stringify({ cash: b.book.cash, positions: b.book.positions }) : null;
      await connect(b);
      stats.reconnects++;
      const after = b.book ? JSON.stringify({ cash: b.book.cash, positions: b.book.positions }) : null;
      if (before !== after && b.sent.size === 0 && !RECOVER) stats.reconnectMismatch++;
    }),
  );

  await sleep(DURATION / 2);
  timers.forEach(clearInterval);
  await sleep(1500);
  bots.forEach((b) => { const ws = b.ws; b.ws = null; ws?.close(); });

  // Reconnecting bots miss what was published while they were away (they get it in hello instead).
  const missed = [...stats.eventArrivals.values()].filter((seen) => seen.size < CLIENTS - Math.floor(CLIENTS * RECONNECT_FRACTION)).length;
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
    news: { stories: stats.eventArrivals.size, storiesSomeoneMissed: missed },
    research: { requests: stats.researchMs.length, errors: stats.researchErrors, p50: pct(stats.researchMs, 50), p95: pct(stats.researchMs, 95), p99: pct(stats.researchMs, 99) },
    socketErrors: stats.errors,
    rooms: ROOMS, inconsistentTicks: stats.inconsistentTicks, crossRoomFills: stats.crossRoom, outages: stats.outages, ticksCompared: stats.tickPrices.size,
    screen: { polls: stats.screenMs.length, errors: stats.screenErrors, p50: pct(stats.screenMs, 50), p95: pct(stats.screenMs, 95) },
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = stats.dupesExecutedTwice === 0 && stats.reconnectMismatch === 0 && stats.joined === CLIENTS && (!RECOVER || stats.connected === CLIENTS || stats.errors === 0) && (RECOVER || !stats.rejects.server_error)
    && stats.inconsistentTicks === 0 && stats.crossRoom === 0 && (RECOVER || missed === 0) && stats.researchErrors === 0 && stats.screenErrors === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
