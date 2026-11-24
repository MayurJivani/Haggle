import { z } from 'zod';

const seconds = (fallback: number) => z.coerce.number().int().min(5).max(24 * 3600).default(fallback);
const list = z.string().default('').transform((v) => v.split(',').map((f) => f.trim()).filter(Boolean));
const exchanges = z.string().transform((v) => v.split(',').map((f) => f.trim()).filter(Boolean))
  .pipe(z.array(z.enum(['US', 'LSE', 'XETRA', 'EURONEXT', 'TSE', 'HKEX', 'SSE', 'TSX', 'ASX'])));
// z.coerce.boolean would read the string "false" as true.
const flag = (fallback: boolean) => z.enum(['true', 'false', '1', '0', '']).default(fallback ? 'true' : 'false').transform((v) => v === 'true' || v === '1');
const tz = z.string().refine((t) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: t });
    return true;
  } catch {
    return false;
  }
}, 'must be an IANA time zone such as Europe/London');

const envSchema = z
  .object({
    // Defaults to production so a deploy that forgot NODE_ENV gets secure cookies and terse errors.
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().positive().default(4371),
    DATABASE_URL: z
      .string()
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// connection string'),
    // Bearer token for POST /api/admin/start. Empty disables the admin route entirely.
    ADMIN_TOKEN: z
      .string()
      .default('')
      .refine((v) => v === '' || v.length >= 24, 'ADMIN_TOKEN must be empty or at least 24 characters'),
    // Comma-separated origins allowed to open the WebSocket and POST to the API. Empty = same host only.
    ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
    // z.coerce.boolean would read the string "false" as true.
    TRUST_PROXY: z.enum(['true', 'false', '1', '0', '']).default('').transform((v) => v === 'true' || v === '1'),
    LOBBY_SECONDS: seconds(120),
    TRADING_SECONDS: seconds(600),
    CLOSING_SECONDS: seconds(60),
    RESULTS_SECONDS: seconds(180),
    TICK_MS: z.coerce.number().int().min(250).max(5000).default(1000),
    MAX_PLAYERS: z.coerce.number().int().min(1).max(5000).default(1000),
    // Custom rooms live at once across every host; each host may run three.
    MAX_ROOMS: z.coerce.number().int().min(0).max(1000).default(50),
    // Joins per IP per minute. A hosted event puts a whole room behind one NAT, so this is generous.
    JOIN_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
    // Fixed market seed for reproducible demos; unset = random per session.
    MARKET_SEED: z.coerce.number().int().optional(),
    TICK_RETENTION_DAYS: z.coerce.number().min(1).max(3650).default(30),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Haggle RealTime (docs/realtime.md). Providers in priority order; empty = RealTime is switched off.
    REALTIME_PROVIDERS: list.pipe(z.array(z.enum(['alpaca', 'twelvedata', 'dev']))),
    ALPACA_KEY_ID: z.string().default(''),
    ALPACA_SECRET_KEY: z.string().default(''),
    ALPACA_FEED: z.enum(['iex', 'sip', 'delayed_sip']).default('iex'),
    ALPACA_RATE_PER_MIN: z.coerce.number().int().min(1).default(180),
    ALPACA_STREAM_MAX: z.coerce.number().int().min(0).default(30),
    TWELVEDATA_API_KEY: z.string().default(''),
    TWELVEDATA_EXCHANGES: exchanges.default(['US']),
    TWELVEDATA_REALTIME: exchanges.default(['US']),
    TWELVEDATA_DELAY_MIN: z.coerce.number().int().min(0).default(15),
    TWELVEDATA_CREDITS_PER_MIN: z.coerce.number().int().min(1).default(8),
    TWELVEDATA_WS: flag(false),
    TWELVEDATA_WS_MAX: z.coerce.number().int().min(0).default(8),
    REALTIME_STARTING_CASH: z.coerce.number().int().min(100).max(10_000_000).default(10_000),
    REALTIME_TZ: tz.default('Europe/London'),
    REALTIME_MAX_QUOTE_AGE_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    REALTIME_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500).default(5),
    REALTIME_MAX_SPREAD_BPS: z.coerce.number().int().min(1).max(5000).default(200),
    REALTIME_DELAYED_FILLS: flag(false),
    REALTIME_EXTENDED_HOURS: flag(true),
    REALTIME_PARTIAL_FILLS: flag(true),
    REALTIME_CATALOGUE_SYNC: flag(true),
    // Development and tests only: start the RealTime clock at this instant (it then runs at normal speed).
    REALTIME_CLOCK: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((e) => e.CLOSING_SECONDS < e.TRADING_SECONDS, {
    message: 'CLOSING_SECONDS must be shorter than TRADING_SECONDS',
    path: ['CLOSING_SECONDS'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || (!e.REALTIME_PROVIDERS.includes('dev') && !e.REALTIME_CLOCK), {
    message: 'the dev provider and REALTIME_CLOCK are refused in production: they are not real market data',
    path: ['REALTIME_PROVIDERS'],
  })
  .refine((e) => !e.REALTIME_PROVIDERS.includes('alpaca') || (e.ALPACA_KEY_ID && e.ALPACA_SECRET_KEY), {
    message: 'alpaca needs ALPACA_KEY_ID and ALPACA_SECRET_KEY',
    path: ['ALPACA_KEY_ID'],
  })
  .refine((e) => !e.REALTIME_PROVIDERS.includes('twelvedata') || e.TWELVEDATA_API_KEY, {
    message: 'twelvedata needs TWELVEDATA_API_KEY',
    path: ['TWELVEDATA_API_KEY'],
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Logger depends on env, so this one line goes to stderr directly before exiting.
    process.stderr.write(
      `Invalid environment configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
