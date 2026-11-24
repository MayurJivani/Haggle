import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { COOKIE, COOKIE_MAX_AGE_MS, clientKey, cookieFrom, createUser, nicknameSchema, originAllowed, userForToken } from './auth.js';
import type { Sql } from './db/db.js';
import type { Env } from './env.js';
import { logger } from './logger.js';
import { metrics, renderMetrics } from './metrics.js';
import { HOUSE, type Engine } from './session/engine.js';
import { ASSETS, CORE_TICKERS, SECTORS } from './market/assets.js';
import type { IndexHistory, PlayerResult, PriceHistory, Range } from './protocol.js';
import { realtimeRouter } from './realtime/routes.js';
import type { Realtime } from './realtime/service.js';
import {
  firstPrices, indexBars, participantId, priceBars, priceSpan, replayOf, resultFor, sessionById, sessionByCode, sessionResults, sessionsBetween, tradesFor,
  type PricePoint,
} from './session/store.js';
import { ROOM_CODE } from './ws.js';

const RANGE_MS: Record<Exclude<Range, 'all'>, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000, '1mo': 2_592_000_000,
};
/** Most bars one history response carries; the bucket grows with the range to stay under it. */
const MAX_BARS = 600;
/** Fewest companies a room may list: fewer leaves nothing to choose between. */
const MIN_COMPANIES = 5;
const rangeSchema = z.enum(['1m', '5m', '15m', '1h', '1d', '1w', '1mo', 'all']);
const tickerSchema = z.string().regex(/^[A-Z0-9]{1,10}$/);

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

function bearerMatches(req: Request, token: string): boolean {
  if (!token) return false;
  const given = Buffer.from(req.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(sql: Sql, engine: Engine, env: Env, rt: Realtime | null = null) {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'self' covers same-origin ws:// and wss:// in current browsers; nothing else is fetched.
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          // Motion and Lightweight Charts set inline style attributes from script.
          styleSrc: ["'self'", "'unsafe-inline'"],
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  // Room settings can name every company on the market; nothing else comes close to this.
  app.use(express.json({ limit: '4kb' }));

  // CSRF: every state-changing request must come from our own origin (see originAllowed).
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('authorization')) return next(); // bearer-token admin calls carry no cookie authority
    if (!originAllowed(req.get('origin'), req.get('host'), env.ALLOWED_ORIGINS)) return void res.status(403).json({ error: 'Cross-origin request refused' });
    next();
  });

  const ipKey = (req: Request) => clientKey(req, env.TRUST_PROXY);
  const joinLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.JOIN_RATE_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: ipKey,
    handler: (req, res) => {
      logger.warn({ ip: ipKey(req) }, 'join rate limit hit');
      res.status(429).json({ error: 'Too many joins from this network. Wait a minute and try again.' });
    },
  });

  const secure = (req: Request) => req.secure;

  const userOf = (req: Request) => userForToken(sql, cookieFrom(req.headers.cookie, COOKIE));
  const codeSchema = z.string().regex(ROOM_CODE);

  app.get('/api/me', async (req, res) => {
    const user = await userOf(req);
    const code = codeSchema.safeParse(req.query.room);
    const live = code.success ? engine.liveByCode(code.data) : engine.house;
    res.json({ user, session: engine.sessionInfo(live ?? null), serverNow: Date.now() });
  });

  app.post('/api/join', joinLimiter, async (req, res) => {
    const existing = await userForToken(sql, cookieFrom(req.headers.cookie, COOKIE));
    if (existing) return void res.json({ user: existing });
    const parsed = z.object({ nickname: nicknameSchema }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid nickname' });
    const created = await createUser(sql, parsed.data.nickname);
    if (!created) return void res.status(409).json({ error: 'That name is taken. Try another.' });
    res.cookie(COOKIE, created.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secure(req),
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
    logger.info({ user: created.user.id }, 'user joined');
    res.status(201).json({ user: created.user });
  });

  app.post('/api/leave', (req, res) => {
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: secure(req) });
    res.status(204).end();
  });

  // Research data. Prices and reports are the same for everyone, so a short shared cache absorbs a
  // whole room opening the same chart at the same moment.
  const cache = new Map<string, { until: number; body: PriceHistory }>();
  const remember = (key: string, body: PriceHistory, ms: number) => {
    if (cache.size > 2000) cache.clear();
    cache.set(key, { until: Date.now() + ms, body });
  };

  /** Bars for a range counted back from the latest stored price, sized to stay under MAX_BARS. */
  const history = async (subject: string, range: Range, span: PriceHistory['span'], bars: (from: Date, bucketMs: number) => Promise<PricePoint[]>): Promise<PriceHistory> => {
    const tickMs = engine.sessionInfo()?.tickMs ?? 1000;
    const body: PriceHistory = { ticker: subject, range, bucketMs: tickMs, bars: [], span, sessions: [] };
    if (!span) return body;
    // Ranges count back from the latest stored price, so a lobby still shows the last competition.
    const from = range === 'all' ? span.first : Math.max(span.first, span.last - RANGE_MS[range]);
    const wanted = Math.ceil((span.last - from + tickMs) / MAX_BARS / 1000) * 1000;
    const bucketMs = Math.max(tickMs, wanted);
    const [rows, sessions] = await Promise.all([bars(new Date(from), bucketMs), sessionsBetween(sql, new Date(from), new Date(span.last))]);
    return { ...body, bucketMs, bars: rows.map((b) => [b.at, b.o, b.h, b.l, b.c, b.seq]), sessions };
  };
  // A hosted room shares one IP, so a signed-in trader is limited as themselves. Only a cookie that names a
  // real user counts: keyed on the raw cookie, every made-up value was a fresh bucket.
  const userKey = async (req: Request) => {
    const user = await userOf(req);
    return user ? `u:${user.id}` : ipKey(req);
  };
  const researchLimiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: userKey,
  });

  app.get('/api/market', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache').type('application/json').send(engine.marketJsonBody());
  });

  app.get('/api/floor', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache').json(await engine.floor());
  });

  app.get('/api/quotes', researchLimiter, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache').json({ quotes: engine.quotes() });
  });

  app.get('/api/companies/:ticker', researchLimiter, (req, res) => {
    const ticker = tickerSchema.safeParse(req.params.ticker);
    const reports = ticker.success ? engine.companyReports(ticker.data) : null;
    if (!reports) return void res.status(404).json({ error: 'That company is not listed' });
    res.setHeader('Cache-Control', 'no-cache').json({ ticker: ticker.data, reports });
  });

  app.get('/api/prices/:ticker', researchLimiter, async (req, res) => {
    const ticker = tickerSchema.safeParse(req.params.ticker);
    const range = rangeSchema.safeParse(req.query.range ?? 'all');
    if (!ticker.success || !range.success || !engine.companyReports(ticker.data)) return void res.status(400).json({ error: 'Unknown company or range' });
    const key = `${ticker.data}:${range.data}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return void res.json(hit.body);
    const span = await priceSpan(sql, ticker.data);
    const body = await history(ticker.data, range.data, span, (from, bucketMs) => priceBars(sql, ticker.data, from, bucketMs));
    remember(key, body, 1000);
    res.json(body);
  });

  // Each company's first price never changes once recorded; a company not yet traded is asked again.
  let bases: Record<string, number> = {};
  const indexBase = async () => {
    if (Object.keys(bases).length < ASSETS.length) bases = await firstPrices(sql, ASSETS.map((a) => a.ticker));
    return bases;
  };

  app.get('/api/index', researchLimiter, async (req, res) => {
    const range = rangeSchema.safeParse(req.query.range ?? 'all');
    const sector = z.enum(SECTORS).optional().safeParse(req.query.sector || undefined);
    if (!range.success || !sector.success) return void res.status(400).json({ error: 'Unknown sector or range' });
    const subject = sector.data ?? 'market';
    // The index of what this competition lists. A room that has left memory falls back to the core listing.
    const code = codeSchema.safeParse(req.query.room);
    const listed = (code.success ? engine.liveByCode(code.data) : engine.house)?.listed ?? new Set(CORE_TICKERS);
    const key = `index:${code.success ? code.data : ''}:${subject}:${range.data}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return void res.json(hit.body);
    const all = await indexBase();
    const base = Object.fromEntries(ASSETS.filter((a) => listed.has(a.ticker) && (!sector.data || a.sector === sector.data)).flatMap((a) => (all[a.ticker] ? [[a.ticker, all[a.ticker]!]] : [])));
    const members = Object.keys(base);
    // Every company ticks together. The span starts at the youngest member, so a room mixing old and newly listed
    // companies never shows a false step where the new ones joined the average. Core companies are listed first.
    const youngest = members.find((t) => !CORE_TICKERS.includes(t)) ?? members[0];
    const span = youngest ? await priceSpan(sql, youngest) : null;
    const body: IndexHistory = { ...(await history(subject, range.data, span, (from, bucketMs) => indexBars(sql, base, from, bucketMs))), base };
    // Long ranges aggregate the whole tape; the client folds live ticks in, so they can be cached longer.
    remember(key, body, Math.min(30_000, Math.max(1000, body.bucketMs)));
    res.json(body);
  });

  // Trades per company in the house competition, or in a room by its code (private rooms: their own traders).
  app.get('/api/activity', researchLimiter, async (req, res) => {
    const code = codeSchema.safeParse(req.query.room);
    const live = code.success ? engine.liveByCode(code.data) : engine.house;
    if (live && live !== engine.house && !engine.canView(live, (await userOf(req))?.id ?? null)) return void res.status(403).json({ error: 'This room is private' });
    res.setHeader('Cache-Control', 'no-cache').json(await engine.activity(live ?? null));
  });

  app.get('/api/reactions', researchLimiter, (req, res) => {
    const code = codeSchema.safeParse(req.query.room);
    res.setHeader('Cache-Control', 'no-cache').json({ reactions: engine.reactions(code.success ? engine.liveByCode(code.data) : engine.house) });
  });

  // The player's own trades in the house competition, or in a room (live or finished) by its code.
  app.get('/api/me/trades', async (req, res) => {
    const user = await userOf(req);
    const code = codeSchema.safeParse(req.query.room);
    let participant: string | null = null;
    if (user && !code.success) participant = engine.participantOf(user.id, HOUSE);
    else if (user && code.success) {
      const id = await engine.resolveRoom(code.data);
      participant = id ? await participantId(sql, id, user.id) : null;
    }
    res.setHeader('Cache-Control', 'no-store').json({ trades: participant ? await tradesFor(sql, participant, 500) : [] });
  });

  // ---------------------------------------------------------------- custom rooms

  const roomLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 6,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: userKey,
    handler: (_req, res) => void res.status(429).json({ error: 'You have opened several rooms just now. Wait a few minutes.' }),
  });

  const roomSchema = z.object({
    name: z.string().trim().min(1, 'Give the room a name').max(40),
    description: z.string().trim().max(200).optional().transform((v) => v || null),
    visibility: z.enum(['public', 'private']).default('public'),
    maxPlayers: z.number().int().min(2).max(env.MAX_PLAYERS).default(Math.min(50, env.MAX_PLAYERS)),
    /** Whole euros. */
    startingCash: z.number().int().min(1_000).max(1_000_000).default(10_000),
    durationMinutes: z.number().int().min(2).max(120).default(10),
    /** Epoch ms of a scheduled bell; omitted = the host starts it. */
    startAt: z.number().int().optional(),
    lateJoin: z.boolean().default(true),
    peek: z.boolean().default(false),
    reveal: z.boolean().default(true),
    publicResults: z.boolean().default(false),
    /** The companies the room lists; omitted = the core listing. */
    tickers: z.array(z.string().max(10)).min(MIN_COMPANIES, `Pick at least ${MIN_COMPANIES} companies`).max(ASSETS.length).optional(),
  });

  app.post('/api/rooms', roomLimiter, async (req, res) => {
    const user = await userOf(req);
    if (!user) return void res.status(401).json({ error: 'Pick a trader name first' });
    const parsed = roomSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Those room settings are not valid' });
    const r = parsed.data;
    const now = Date.now();
    if (r.startAt !== undefined && (r.startAt < now + 30_000 || r.startAt > now + 7 * 86_400_000)) {
      return void res.status(400).json({ error: 'Schedule the bell between 30 seconds and 7 days from now' });
    }
    const known = new Set(ASSETS.map((a) => a.ticker));
    if (r.tickers && (new Set(r.tickers).size !== r.tickers.length || r.tickers.some((t) => !known.has(t)))) {
      return void res.status(400).json({ error: 'That company list is not valid' });
    }
    const made = await engine.createRoom(user, {
      name: r.name, description: r.description, visibility: r.visibility, maxPlayers: r.maxPlayers, startingCash: r.startingCash * 100,
      durationSeconds: r.durationMinutes * 60, startAt: r.startAt ?? null, lateJoin: r.lateJoin, peek: r.peek, reveal: r.reveal,
      publicResults: r.visibility === 'public' || r.publicResults, tickers: r.tickers ?? CORE_TICKERS,
    });
    if ('error' in made) return void res.status(409).json(made);
    res.status(201).json(made);
  });

  app.get('/api/rooms', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store').json({ rooms: engine.listRooms() });
  });

  /** What a room is, for the page someone lands on from an invite link. The code is the invitation. */
  app.get('/api/rooms/:code', async (req, res) => {
    const code = codeSchema.safeParse(req.params.code);
    const live = code.success ? engine.liveByCode(code.data) : undefined;
    if (live) return void res.setHeader('Cache-Control', 'no-store').json({ session: engine.sessionInfo(live), finished: false });
    const row = code.success ? await sessionByCode(sql, code.data) : null;
    if (!row) return void res.status(404).json({ error: 'There is no room with that code' });
    res.json({ name: row.name, finished: true });
  });

  const hostAction = (act: 'start' | 'close') => async (req: Request, res: Response) => {
    const user = await userOf(req);
    const code = codeSchema.safeParse(req.params.code);
    const live = code.success ? engine.liveByCode(code.data) : undefined;
    if (!live) return void res.status(404).json({ error: 'There is no live room with that code' });
    if (!user || !engine.isHost(live, user.id)) return void res.status(403).json({ error: 'Only the host can do that' });
    const done = act === 'start' ? await engine.openNow(live) : await engine.closeNow(live);
    res.status(done ? 200 : 409).json({ ok: done, session: engine.sessionInfo(live) });
  };
  app.post('/api/rooms/:code/start', hostAction('start'));
  app.post('/api/rooms/:code/close', hostAction('close'));

  // ---------------------------------------------------------------- leaderboards and portfolios

  /** Every trader in a live competition at one valuation time. Private rooms show it to their own traders only. */
  app.get('/api/sessions/:id/board', researchLimiter, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const live = id.success ? engine.rooms.get(id.data) : undefined;
    if (!live) return void res.status(404).json({ error: 'That competition is not live' });
    const user = await userOf(req);
    if (!engine.canView(live, user?.id ?? null)) return void res.status(403).json({ error: 'This room is private' });
    res.setHeader('Cache-Control', 'no-store').json(engine.fullBoard(live));
  });

  /** A rival's portfolio during the game, only where the room allows peeking and only to its own traders. */
  app.get('/api/sessions/:id/portfolio/:participantId', researchLimiter, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const pid = z.uuid().safeParse(req.params.participantId);
    const live = id.success ? engine.rooms.get(id.data) : undefined;
    const user = await userOf(req);
    if (!live || !pid.success) return void res.status(404).json({ error: 'That competition is not live' });
    if (!live.cfg.peek || !user || !live.players.has(user.id)) return void res.status(403).json({ error: 'Portfolios are private in this room' });
    const view = engine.portfolioOf(live, pid.data);
    if (!view) return void res.status(404).json({ error: 'No such trader in this room' });
    res.setHeader('Cache-Control', 'no-store').json(view);
  });

  app.get('/api/results/:participantId', async (req, res) => {
    const id = z.uuid().safeParse(req.params.participantId);
    const result = id.success ? await resultFor(sql, id.data) : null;
    if (!result) return void res.status(404).json({ error: 'No result for that player yet' });
    res.json({ result });
  });

  // The whole final roster with everyone's portfolio, published only once a competition has closed
  // (results do not exist before), so nobody can copy a rival's book while trading is open. A private
  // room shows it to its own traders only, unless the host made the results public; a room that keeps
  // portfolios private shows each trader only their own holdings.
  /** A competition's row and the viewer's participant id, or null once a 404 or 403 is sent. */
  const resultsAccess = async (req: Request, res: Response) => {
    const id = z.uuid().safeParse(req.params.id);
    const row = id.success ? await sessionById(sql, id.data) : null;
    if (!row) return void res.status(404).json({ error: 'Unknown session' });
    const user = await userOf(req);
    const mine = user ? await participantId(sql, row.id, user.id) : null;
    if (row.visibility === 'private' && !row.config.publicResults && !mine) return void res.status(403).json({ error: 'This room is private' });
    return { row, mine };
  };

  app.get('/api/sessions/:id/results', researchLimiter, async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(5000).default(100).safeParse(req.query.limit);
    if (!limit.success) return void res.status(404).json({ error: 'Unknown session' });
    const access = await resultsAccess(req, res);
    if (!access) return;
    const { row, mine } = access;
    let results: PlayerResult[] = await sessionResults(sql, row.id, limit.data);
    if (row.config.reveal === false) results = results.map((r) => (r.participantId === mine ? r : { ...r, holdings: undefined }));
    // A finished competition's results never change; who may see them depends on the cookie.
    res.setHeader('Cache-Control', row.visibility === 'private' || row.config.reveal === false ? 'private, max-age=300' : 'public, max-age=300');
    res.json({ results });
  });

  // The race behind the results: the top ten and the viewer through the snapshots. Values only, never
  // holdings, so it follows the results' visibility and nothing more.
  app.get('/api/sessions/:id/replay', researchLimiter, async (req, res) => {
    const access = await resultsAccess(req, res);
    if (!access) return;
    const { row, mine } = access;
    if (row.status !== 'finished') return void res.status(404).json({ error: 'That competition has not finished' });
    const ids = (await sessionResults(sql, row.id, 10)).map((r) => r.participantId);
    if (mine && !ids.includes(mine)) ids.push(mine);
    // The viewer's own line rides along, so no shared cache may keep it.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(await replayOf(sql, row, ids));
  });

  // Organiser routes: Bearer ADMIN_TOKEN, used by the /host console and by curl. Unset token = 404.
  const admin = (req: Request, res: Response, next: NextFunction) => {
    if (!env.ADMIN_TOKEN) return void res.status(404).end();
    if (!bearerMatches(req, env.ADMIN_TOKEN)) {
      logger.warn({ ip: req.ip, path: req.path }, 'admin request refused');
      return void res.status(401).json({ error: 'That host code is not right' });
    }
    next();
  };

  app.get('/api/host', admin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store').json(engine.hostView());
  });

  app.post('/api/admin/start', admin, async (_req, res) => {
    const opened = await engine.openNow();
    res.status(opened ? 200 : 409).json({ opened, session: engine.sessionInfo() });
  });

  app.post('/api/admin/close', admin, async (_req, res) => {
    const closed = await engine.closeNow();
    res.status(closed ? 200 : 409).json({ closed, session: engine.sessionInfo() });
  });

  app.post('/api/admin/next', admin, (_req, res) => {
    const next = engine.nextNow();
    res.status(next ? 200 : 409).json({ next });
  });

  if (rt) app.use('/api/rt', realtimeRouter(rt, userOf, ipKey));
  else app.use('/api/rt', (_req, res) => void res.status(503).json({ error: 'Haggle RealTime is not configured on this server' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await sql`SELECT 1`;
      // Stale market: the clock is behind, ticks are piling up undurable, or another process fenced us.
      const lagging = metrics.tickLagMs > 5000 || metrics.checkpointLagTicks > 120 || engine.fenced;
      res.status(lagging ? 503 : 200).json({
        ok: !lagging, db: true, tickLagMs: metrics.tickLagMs, checkpointLagTicks: metrics.checkpointLagTicks, fenced: engine.fenced,
        session: engine.sessionInfo()?.phase ?? null,
      });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.get('/metrics', (req, res) => {
    if (!bearerMatches(req, env.ADMIN_TOKEN)) return void res.status(404).end();
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  if (existsSync(WEB_DIST)) {
    // Hashed bundles never change under their name; everything else revalidates against its ETag.
    app.use('/assets', express.static(WEB_DIST + 'assets', { immutable: true, maxAge: '1y' }));
    app.use(express.static(WEB_DIST, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.setHeader('Cache-Control', 'no-cache').sendFile(WEB_DIST + 'index.html'));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.path }, 'request failed');
    res.status(500).json({ error: 'Something went wrong on our side' });
  });

  return app;
}
