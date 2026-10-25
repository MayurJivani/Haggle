import { z } from 'zod';

const seconds = (fallback: number) => z.coerce.number().int().min(5).max(24 * 3600).default(fallback);

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
    MAX_PLAYERS: z.coerce.number().int().min(1).max(5000).default(500),
    // Custom rooms live at once across every host; each host may run three.
    MAX_ROOMS: z.coerce.number().int().min(0).max(1000).default(50),
    // Joins per IP per minute. A hosted event puts a whole room behind one NAT, so this is generous.
    JOIN_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
    // Fixed market seed for reproducible demos; unset = random per session.
    MARKET_SEED: z.coerce.number().int().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .refine((e) => e.CLOSING_SECONDS < e.TRADING_SECONDS, {
    message: 'CLOSING_SECONDS must be shorter than TRADING_SECONDS',
    path: ['CLOSING_SECONDS'],
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
