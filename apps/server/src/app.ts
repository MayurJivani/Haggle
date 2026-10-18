import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { COOKIE, COOKIE_MAX_AGE_MS, cookieFrom, createUser, nicknameSchema, originAllowed, userForToken } from './auth.js';
import type { Sql } from './db/db.js';
import type { Env } from './env.js';
import { logger } from './logger.js';
import { metrics, renderMetrics } from './metrics.js';
import type { Engine } from './session/engine.js';
import { resultFor, sessionResults } from './session/store.js';

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

  app.post('/api/admin/start', async (req, res) => {
    if (!env.ADMIN_TOKEN) return void res.status(404).end();
    if (!bearerMatches(req, env.ADMIN_TOKEN)) {
      logger.warn({ ip: req.ip }, 'admin start refused');
      return void res.status(401).json({ error: 'Bad admin token' });
    }
    const opened = await engine.openNow();
    res.status(opened ? 200 : 409).json({ opened, session: engine.sessionInfo() });
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await sql`SELECT 1`;
      const lagging = metrics.tickLagMs > 5000;
      res.status(lagging ? 503 : 200).json({ ok: !lagging, db: true, tickLagMs: metrics.tickLagMs, session: engine.sessionInfo()?.phase ?? null });
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
