import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { COOKIE, cookieFrom, originAllowed, userForToken } from './auth.js';
import type { Sql } from './db/db.js';
import { logger } from './logger.js';
import type { ClientMsg } from './protocol.js';
import type { Client, Engine } from './session/engine.js';
import { MAX_ORDER_QTY } from './trading/portfolio.js';
import type { Client as RtClient, Realtime } from './realtime/service.js';

export const ROOM_CODE = /^[A-Z2-9]{8}$/;

const orderSchema = z.object({
  t: z.literal('order'),
  id: z.uuid(),
  side: z.enum(['buy', 'sell']),
  ticker: z.string().min(1).max(10),
  qty: z.number().int().min(1).max(MAX_ORDER_QTY),
});

// Token bucket per socket: a burst of 8 orders, refilling 4 per second. A player clicking fast never
// notices; a script hammering the socket gets rejections, then disconnected.
const BURST = 8;
const REFILL_PER_SEC = 4;
const STRIKES_BEFORE_CLOSE = 50;
/** Skip price ticks for a client this far behind; the next tick carries absolute prices anyway. */
const SLOW_CLIENT_BYTES = 512 * 1024;

export function attachSockets(server: Server, sql: Sql, engine: Engine, allowedOrigins: string[], rt: Realtime | null = null) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const rtWss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/rt/ws' && rt) {
      if (!originAllowed(req.headers.origin, req.headers.host, allowedOrigins)) return refuse('403 Forbidden');
      // Prices are for everyone; the cookie only decides whose fills and notifications arrive here.
      void userForToken(sql, cookieFrom(req.headers.cookie, COOKIE))
        .then((user) => rtWss.handleUpgrade(req, socket, head, (ws) => onRealtime(ws, rt, user?.id ?? '')))
        .catch(() => refuse('503 Service Unavailable'));
      return;
    }
    if (url.pathname !== '/ws') return refuse('404 Not Found');
    if (!originAllowed(req.headers.origin, req.headers.host, allowedOrigins)) return refuse('403 Forbidden');
    // A room code is the key to a room: private rooms are reached by nothing else.
    const code = url.searchParams.get('room');
    if (code !== null && !ROOM_CODE.test(code)) return refuse('404 Not Found');
    Promise.all([userForToken(sql, cookieFrom(req.headers.cookie, COOKIE)), engine.resolveRoom(code)])
      .then(([user, room]) => {
        if (!user) return refuse('401 Unauthorized');
        if (room === null) return refuse('404 Not Found');
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, room));
      })
      .catch((err) => {
        logger.error({ err }, 'upgrade auth failed');
        refuse('503 Service Unavailable');
      });
  });

  function onConnection(ws: WebSocket, user: { id: string; nickname: string }, room: string) {
    let tokens = BURST;
    let last = Date.now();
    let strikes = 0;
    let alive = true;

    const client: Client = {
      userId: user.id,
      nickname: user.nickname,
      room,
      send(data) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > SLOW_CLIENT_BYTES && data.startsWith('{"t":"tick"')) return;
        ws.send(data);
      },
    };

    const reject = (id: unknown, reason: string) =>
      client.send(JSON.stringify({ t: 'reject', id: typeof id === 'string' ? id : '', reason }));

    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);

    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + ((now - last) / 1000) * REFILL_PER_SEC);
      last = now;
      let msg: unknown;
      try {
        msg = isBinary ? null : JSON.parse(raw.toString());
      } catch {
        msg = null;
      }
      const id = (msg as { id?: unknown } | null)?.id;
      if (tokens < 1) {
        if (++strikes >= STRIKES_BEFORE_CLOSE) ws.close(1008, 'rate limited');
        return reject(id, 'rate_limited');
      }
      tokens -= 1;
      const parsed = orderSchema.safeParse(msg);
      if (!parsed.success) return reject(id, 'bad_request');
      void engine.order(client, parsed.data as ClientMsg).catch((err) => logger.error({ err }, 'order crashed'));
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      engine.detach(client);
    });
    ws.on('error', (err) => logger.warn({ err }, 'socket error'));

    engine.attach(client).catch((err) => {
      logger.error({ err }, 'attach failed');
      ws.close(1011, 'try again');
    });
  }

  return [wss, rtWss];
}

const rtMsg = z.object({ t: z.enum(['sub', 'unsub']), ids: z.array(z.number().int().positive()).max(300) });

/** One RealTime socket: the instruments on its screen, and the player's own order and fill events. */
function onRealtime(ws: WebSocket, rt: Realtime, userId: string) {
  let alive = true;
  let tokens = BURST;
  let last = Date.now();
  const client: RtClient = {
    userId,
    ids: new Set(),
    send(m) {
      if (ws.readyState !== ws.OPEN) return;
      // A slow phone skips price batches; the next one carries absolute prices anyway.
      if (m.t === 'q' && ws.bufferedAmount > SLOW_CLIENT_BYTES) return;
      ws.send(JSON.stringify(m));
    },
  };
  ws.on('pong', () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 20_000);
  ws.on('message', (raw, isBinary) => {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - last) / 1000) * REFILL_PER_SEC);
    last = now;
    if (tokens < 1) return;
    tokens -= 1;
    let msg: unknown = null;
    try {
      msg = isBinary ? null : JSON.parse(raw.toString());
    } catch {
      return;
    }
    const m = rtMsg.safeParse(msg);
    if (!m.success) return;
    if (m.data.t === 'sub') rt.subscribe(client, m.data.ids);
    else rt.unsubscribe(client, m.data.ids);
  });
  ws.on('close', () => {
    clearInterval(heartbeat);
    rt.detach(client);
  });
  ws.on('error', (err) => logger.warn({ err }, 'realtime socket error'));
  rt.attach(client);
}
