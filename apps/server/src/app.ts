import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { COOKIE, COOKIE_MAX_AGE_MS, cookieFrom, createUser, nicknameSchema, originAllowed, userForToken } from './auth.js';
import type { Sql } from './db/db.js';
import type { Env } from './env.js';
import { logger } from './logger.js';
import { metrics, renderMetrics } from './metrics.js';
import type { Engine } from './session/engine.js';
import { ASSETS, SECTORS } from './market/assets.js';
import type { IndexHistory, PriceHistory, Range } from './protocol.js';
import { firstPrices, indexBars, priceBars, priceSpan, resultFor, sessionResults, sessionsBetween, tradesFor, type PricePoint } from './session/store.js';

const RANGE_MS: Record<Exclude<Range, 'all'>, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000, '1mo': 2_592_000_000,
};
/** Most bars one history response carries; the bucket grows with the range to stay under it. */
const MAX_BARS = 600;
const rangeSchema = z.enum(['1m', '5m', '15m', '1h', '1d', '1w', '1mo', 'all']);
const tickerSchema = z.string().regex(/^[A-Z0-9]{1,10}$/);

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

function bearerMatches(req: Request, token: string): boolean {
  if (!token) return false;
  const given = Buffer.from(req.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(sql: Sql, engine: Engine, env: Env) {
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
  app.use(express.json({ limit: '2kb' }));

  // CSRF: every state-changing request must come from our own origin (see originAllowed).
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('authorization')) return next(); // bearer-token admin calls carry no cookie authority
    if (!originAllowed(req.get('origin'), req.get('host'), env.ALLOWED_ORIGINS)) return void res.status(403).json({ error: 'Cross-origin request refused' });
    next();
  });

  const joinLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.JOIN_RATE_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ ip: req.ip }, 'join rate limit hit');
      res.status(429).json({ error: 'Too many joins from this network. Wait a minute and try again.' });
    },
  });

  const secure = (req: Request) => req.secure;

  app.get('/api/me', async (req, res) => {
    const user = await userForToken(sql, cookieFrom(req.headers.cookie, COOKIE));
    res.json({ user, session: engine.sessionInfo(), serverNow: Date.now() });
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
  const researchLimiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // A hosted room shares one IP; the player's cookie is the fairer key when there is one.
    keyGenerator: (req) => cookieFrom(req.headers.cookie, COOKIE) ?? ipKeyGenerator(req.ip ?? ''),
  });

  app.get('/api/market', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache').type('application/json').send(engine.marketJsonBody());
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
    const key = `index:${subject}:${range.data}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return void res.json(hit.body);
    const all = await indexBase();
    const base = Object.fromEntries(ASSETS.filter((a) => !sector.data || a.sector === sector.data).flatMap((a) => (all[a.ticker] ? [[a.ticker, all[a.ticker]!]] : [])));
    const members = Object.keys(base);
    // Every company ticks together, so any member's span is the index's span.
    const span = members.length ? await priceSpan(sql, members[0]!) : null;
    const body: IndexHistory = { ...(await history(subject, range.data, span, (from, bucketMs) => indexBars(sql, base, from, bucketMs))), base };
    // Long ranges aggregate the whole tape; the client folds live ticks in, so they can be cached longer.
    remember(key, body, Math.min(30_000, Math.max(1000, body.bucketMs)));
    res.json(body);
  });

  app.get('/api/activity', researchLimiter, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache').json(await engine.activity());
  });

  app.get('/api/reactions', researchLimiter, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache').json({ reactions: engine.reactions() });
  });

  app.get('/api/me/trades', async (req, res) => {
    const user = await userForToken(sql, cookieFrom(req.headers.cookie, COOKIE));
    const participant = user ? engine.participantOf(user.id) : null;
    res.setHeader('Cache-Control', 'no-store').json({ trades: participant ? await tradesFor(sql, participant, 200) : [] });
  });

  app.get('/api/results/:participantId', async (req, res) => {
    const id = z.uuid().safeParse(req.params.participantId);
    const result = id.success ? await resultFor(sql, id.data) : null;
    if (!result) return void res.status(404).json({ error: 'No result for that player yet' });
    res.json({ result });
  });

  app.get('/api/sessions/:id/results', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ error: 'Unknown session' });
    res.json({ results: await sessionResults(sql, id.data, 100) });
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
