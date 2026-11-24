// /api/rt: Haggle RealTime's HTTP API. Reads are open to signed-in players; every write is checked against
// the cookie's user, the CSRF origin check in app.ts and a per-user rate limit.
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { User } from '../auth.js';
import { EXCHANGES, exchangeStatus, type ExchangeId } from './calendar.js';
import { HEADLINE_INDICES } from './catalogue.js';
import type { Resolution } from './providers/provider.js';
import type { Realtime } from './service.js';
import type { ChartRange, Details, History, Kind, RejectReason } from './types.js';

const DAY = 86_400_000;
/** Each chart range: how far back, and the bar size that keeps it to a few hundred points. */
export const RANGES: Record<ChartRange, { back: number; res: Resolution }> = {
  '1D': { back: 4 * DAY, res: '5min' },
  '5D': { back: 8 * DAY, res: '15min' },
  '1M': { back: 31 * DAY, res: '1h' },
  '3M': { back: 92 * DAY, res: '1day' },
  '6M': { back: 183 * DAY, res: '1day' },
  '1Y': { back: 366 * DAY, res: '1day' },
  '5Y': { back: 5 * 366 * DAY, res: '1week' },
  MAX: { back: 40 * 366 * DAY, res: '1month' },
};

const EXCHANGE_IDS = Object.keys(EXCHANGES) as [ExchangeId, ...ExchangeId[]];
const idSchema = z.coerce.number().int().positive();
const idsSchema = z.string().max(4000).transform((s) => s.split(',').filter(Boolean).map(Number)).pipe(z.array(z.number().int().positive()).max(300));

const orderSchema = z.object({
  clientOrderId: z.uuid(),
  instrumentId: z.number().int().positive(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit']),
  qty: z.number().int().positive().optional(),
  amount: z.number().int().positive().optional(),
  limitPrice: z.number().int().positive().optional(),
  queue: z.boolean().optional(),
}).refine((o) => (o.qty === undefined) !== (o.amount === undefined), 'Give a quantity or an amount');

const HTTP_FOR: Partial<Record<RejectReason, number>> = { not_joined: 403, unknown_instrument: 404, rate_limited: 429, server_error: 500 };

export function realtimeRouter(rt: Realtime, userOf: (req: Request) => Promise<User | null>, ipKey: (req: Request) => string) {
  const r = express.Router();
  const now = rt.cfg.now;

  const userKey = async (req: Request) => {
    const u = await userOf(req);
    return u ? `u:${u.id}` : ipKey(req);
  };
  const reads = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: userKey });
  const orders = rateLimit({ windowMs: 10_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: userKey, message: { reason: 'rate_limited' } });
  r.use(reads);

  const signedIn = async (req: Request, res: Response) => {
    const u = await userOf(req);
    if (!u) res.status(401).json({ error: 'Pick a nickname first' });
    return u;
  };
  const seasonOf = async (req: Request, res: Response) => {
    const s = await rt.season(String(req.query.season ?? req.body?.season ?? 'open'));
    if (!s) res.status(404).json({ error: 'No such competition' });
    return s;
  };

  r.get('/status', async (_req, res) => {
    const t = now();
    res.json({
      serverNow: t,
      exchanges: EXCHANGE_IDS.map((id) => exchangeStatus(id, t)),
      feed: rt.feedInfo(),
      instruments: await rt.catalogue.count(),
      fxAsOf: rt.market.ratesAsOf,
    });
  });

  r.get('/instruments', async (req, res) => {
    const q = z.object({
      q: z.string().trim().max(60).optional(),
      exchange: z.enum(EXCHANGE_IDS).optional(),
      sector: z.string().max(80).optional(),
      kind: z.enum(['stock', 'etf', 'index', 'adr', 'reit', 'fund']).optional(),
      cap: z.enum(['mega', 'large', 'mid', 'small', 'micro']).optional(),
      trading: z.enum(['open', 'closed']).optional(),
      sort: z.enum(['cap', 'symbol', 'name']).default('cap'),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: 'Bad query' });
    const caps = { mega: [200e9, undefined], large: [10e9, 200e9], mid: [2e9, 10e9], small: [300e6, 2e9], micro: [0, 300e6] } as const;
    const [capMin, capMax] = q.data.cap ? caps[q.data.cap] : [undefined, undefined];
    let exchanges: ExchangeId[] | undefined;
    if (q.data.trading) {
      const t = now();
      exchanges = EXCHANGE_IDS.filter((id) => (exchangeStatus(id, t).state === 'open') === (q.data.trading === 'open'));
    }
    const out = await rt.catalogue.browse({ ...q.data, kind: q.data.kind as Kind | undefined, capMin, capMax, exchanges });
    res.json(out);
  });

  r.get('/fx/:currency', (req, res) => {
    const minor = req.params.currency === 'GBp' || req.params.currency === 'GBX';
    res.json({ rate: rt.market.rates.get(minor ? 'GBP' : req.params.currency!) ?? (req.params.currency === 'EUR' ? '1' : null), asOf: rt.market.ratesAsOf });
  });

  r.get('/sectors', async (_req, res) => res.json({ sectors: await rt.catalogue.sectors() }));

  r.get('/instruments/:id', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const i = id.success ? await rt.catalogue.get(id.data) : null;
    if (!i) return void res.status(404).json({ error: 'Not listed' });
    const covered = !!rt.feeds.for(i);
    if (covered && !rt.market.quote(i.id)) await rt.market.refresh([i]).catch(() => {});
    // 52 weeks from daily bars; no provider call when the chart cache already has the year.
    const year = covered ? await yearRange(i.id) : null;
    const body: Details = { instrument: i, quote: rt.market.quote(i.id) ?? null, status: exchangeStatus(i.exchange, now()), fiftyTwoWeek: year, covered };
    res.json(body);
  });

  const candleCache = new Map<string, { until: number; body: History | null }>();
  async function candles(id: number, range: ChartRange): Promise<History | null> {
    const key = `${id}:${range}`;
    const hit = candleCache.get(key);
    if (hit && hit.until > Date.now()) return hit.body;
    const i = await rt.catalogue.get(id);
    if (!i) return null;
    const { back, res } = RANGES[range];
    const t = now();
    const got = await rt.feeds.candles(i, res, t - back, t);
    let body: History | null = null;
    if (got) {
      let list = got.candles;
      // 1D is the latest session with bars, 5D the last five: weekends and holidays are skipped, never filled.
      if (range === '1D' || range === '5D') {
        const tz = EXCHANGES[i.exchange].tz;
        const days = [...new Set(list.map((c) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(c.t)))];
        const keep = new Set(days.slice(range === '1D' ? -1 : -5));
        list = list.filter((c) => keep.has(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(c.t)));
      }
      const { quality } = got.provider.quality(i);
      body = { id, range, resolution: res, candles: list, currency: i.currency, source: got.provider.id, quality };
    }
    if (candleCache.size > 3000) candleCache.clear();
    candleCache.set(key, { until: Date.now() + (range === '1D' ? 60_000 : range === '5D' ? 5 * 60_000 : 3600_000), body });
    return body;
  }
  async function yearRange(id: number) {
    const h = await candles(id, '1Y').catch(() => null);
    if (!h?.candles.length) return null;
    return { low: Math.min(...h.candles.map((c) => c.l)), high: Math.max(...h.candles.map((c) => c.h)) };
  }

  r.get('/instruments/:id/candles', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const range = z.enum(['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX']).safeParse(req.query.range ?? '1D');
    if (!id.success || !range.success) return void res.status(400).json({ error: 'Bad query' });
    const body = await candles(id.data, range.data);
    if (!body) return void res.status(503).json({ error: 'No configured data provider has history for this instrument right now' });
    res.json(body);
  });

  r.get('/quotes', async (req, res) => {
    const ids = idsSchema.safeParse(String(req.query.ids ?? ''));
    if (!ids.success) return void res.status(400).json({ error: 'Bad ids' });
    const list = await rt.catalogue.many(ids.data);
    res.json({ instruments: list, quotes: list.flatMap((i) => rt.market.quote(i.id) ?? []), status: list.map((i) => ({ id: i.id, status: rt.market.status(i) })) });
  });

  r.get('/overview', async (_req, res) => {
    const idx = await Promise.all(HEADLINE_INDICES.map((x) => rt.catalogue.bySymbol(x.mic, x.symbol)));
    const indices = idx.flatMap((i) => i ?? []);
    const movers = await rt.movers();
    res.json({ indices, movers, trending: rt.market.mostViewed(15) });
  });

  r.get('/news', async (req, res) => {
    const ids = idsSchema.safeParse(String(req.query.ids ?? ''));
    if (!ids.success) return void res.status(400).json({ error: 'Bad ids' });
    res.json({ news: await rt.newsFor(ids.data), configured: rt.feeds.list.some((p) => p.news && p.id !== 'dev') });
  });

  // ---------------------------------------------------------------- player

  r.get('/seasons', async (req, res) => res.json({ seasons: await rt.seasons((await userOf(req))?.id ?? null) }));

  r.post('/seasons/:id/join', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    const s = await rt.season(req.params.id!);
    if (!s) return void res.status(404).json({ error: 'No such competition' });
    const out = await rt.trading.join(u.id, s.id);
    if (!out.ok) return void res.status(409).json({ reason: out.reason, error: 'Registration for this competition has closed' });
    res.json(out);
  });

  r.get('/portfolio', async (req, res) => {
    const u = await signedIn(req, res);
    const s = u && (await seasonOf(req, res));
    if (!u || !s) return;
    let account = await rt.accountFor(u.id, s.id);
    // The open season is joined the first time a player looks at it.
    if (!account && s.kind === 'open') {
      const j = await rt.trading.join(u.id, s.id);
      account = j.ok ? j.accountId : null;
    }
    if (!account) return void res.json({ portfolio: null });
    res.json({ portfolio: await rt.portfolio(account) });
  });

  r.get('/orders', async (req, res) => {
    const u = await signedIn(req, res);
    const s = u && (await seasonOf(req, res));
    if (!u || !s) return;
    res.json({ orders: await rt.ordersOf(u.id, s.id) });
  });

  r.post('/orders', orders, async (req, res) => {
    const u = await signedIn(req, res);
    const s = u && (await seasonOf(req, res));
    if (!u || !s) return;
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ reason: 'bad_request', error: parsed.error.issues[0]?.message });
    const out = await rt.trading.place(u.id, s.id, parsed.data);
    if (!out.ok) return void res.status(HTTP_FOR[out.reason] ?? 422).json({ reason: out.reason });
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  r.delete('/orders/:id', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    if (!z.uuid().safeParse(req.params.id).success) return void res.status(404).end();
    const out = await rt.trading.cancel(u.id, req.params.id!);
    if (!out.ok) return void res.status(404).json({ error: 'No such order' });
    res.json(out);
  });

  r.get('/executions', async (req, res) => {
    const u = await signedIn(req, res);
    const s = u && (await seasonOf(req, res));
    if (!u || !s) return;
    res.json({ executions: await rt.executionsOf(u.id, s.id), ledger: await rt.ledgerOf(u.id, s.id) });
  });

  r.get('/history', async (req, res) => {
    const u = await signedIn(req, res);
    const s = u && (await seasonOf(req, res));
    if (!u || !s) return;
    const account = await rt.accountFor(u.id, s.id);
    res.json({ points: account ? (await rt.history(account)).map((p) => [p.at.getTime(), p.value_cents]) : [] });
  });

  r.get('/watchlist', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    res.json({ ids: await rt.watchlist(u.id) });
  });
  r.put('/watchlist/:id', async (req, res) => {
    const u = await signedIn(req, res);
    const id = idSchema.safeParse(req.params.id);
    if (!u || !id.success || !(await rt.catalogue.get(id.data))) return void (u && res.status(404).end());
    res.json({ ids: await rt.watch(u.id, id.data, true) });
  });
  r.delete('/watchlist/:id', async (req, res) => {
    const u = await signedIn(req, res);
    const id = idSchema.safeParse(req.params.id);
    if (!u || !id.success) return void (u && res.status(404).end());
    res.json({ ids: await rt.watch(u.id, id.data, false) });
  });

  r.get('/leaderboard', async (req, res) => {
    const s = await seasonOf(req, res);
    if (!s) return;
    const sort = z.enum(['value', 'return', 'day', 'pick']).catch('value').parse(req.query.sort);
    const u = await userOf(req);
    const following = u ? new Set(await rt.following(u.id)) : new Set<string>();
    const rows = s.status === 'finished' ? await rt.results(s.id) : await rt.board(s.id, sort, 100);
    res.json({ season: s.id, rows: rows.map(({ accountId: _a, ...r }) => ({ ...r, following: following.has(r.userId) })), you: u?.id ?? null });
  });

  r.get('/players/:id', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return void res.status(404).end();
    const s = await seasonOf(req, res);
    if (!s) return;
    const viewer = await userOf(req);
    const out = await rt.player(req.params.id!, s.id, viewer?.id ?? null);
    if (!out) return void res.status(404).json({ error: 'No such player' });
    res.json(out);
  });

  r.put('/follow/:id', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u || !z.uuid().safeParse(req.params.id).success || req.params.id === u.id) return void (u && res.status(400).end());
    await rt.follow(u.id, req.params.id!, true);
    res.status(204).end();
  });
  r.delete('/follow/:id', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u || !z.uuid().safeParse(req.params.id).success) return void (u && res.status(400).end());
    await rt.follow(u.id, req.params.id!, false);
    res.status(204).end();
  });

  r.get('/activity', async (_req, res) => res.json({ activity: await rt.activity() }));

  r.get('/profile', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    res.json(await rt.profile(u.id));
  });
  r.put('/profile', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    const p = z.object({ public: z.boolean(), muted: z.array(z.enum(['fill', 'move', 'session', 'rank', 'season'])).max(10) }).safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: 'Bad profile' });
    res.json(await rt.setProfile(u.id, p.data.public, p.data.muted));
  });

  r.get('/notifications', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    res.json({ notifications: await rt.notifications(u.id) });
  });
  r.post('/notifications/read', async (req, res) => {
    const u = await signedIn(req, res);
    if (!u) return;
    await rt.markRead(u.id);
    res.status(204).end();
  });

  return r;
}
