import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connect, migrate } from './db/db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { Engine } from './session/engine.js';
import { attachSockets } from './ws.js';
import { providersFromEnv, Realtime } from './realtime/service.js';

const sql = connect(env.DATABASE_URL);
const applied = await migrate(sql);
if (applied.length) logger.info({ applied }, 'migrations applied');

const engine = new Engine(
  sql,
  {
    lobbySeconds: env.LOBBY_SECONDS,
    tradingSeconds: env.TRADING_SECONDS,
    closingSeconds: env.CLOSING_SECONDS,
    resultsSeconds: env.RESULTS_SECONDS,
    tickMs: env.TICK_MS,
    maxPlayers: env.MAX_PLAYERS,
    maxRooms: env.MAX_ROOMS,
    seed: env.MARKET_SEED,
    marketSeed: env.MARKET_SEED,
    tickRetentionDays: env.TICK_RETENTION_DAYS,
  },
  logger,
);
await engine.start();

// Haggle RealTime runs beside the simulated game and only when a data provider is configured.
let rt: Realtime | null = null;
if (env.REALTIME_PROVIDERS.length) {
  const shift = env.REALTIME_CLOCK ? Date.parse(env.REALTIME_CLOCK) - Date.now() : 0;
  const now = () => Date.now() + shift;
  rt = new Realtime(sql, logger.child({ mode: 'realtime' }), {
    providers: providersFromEnv(env, now),
    startingCash: env.REALTIME_STARTING_CASH,
    tz: env.REALTIME_TZ,
    policy: {
      maxQuoteAgeMs: env.REALTIME_MAX_QUOTE_AGE_SECONDS * 1000, slippageBps: env.REALTIME_SLIPPAGE_BPS, maxSpreadBps: env.REALTIME_MAX_SPREAD_BPS,
      delayedFills: env.REALTIME_DELAYED_FILLS, extendedHours: env.REALTIME_EXTENDED_HOURS, partialFills: env.REALTIME_PARTIAL_FILLS,
    },
    catalogueSync: env.REALTIME_CATALOGUE_SYNC,
    tdKey: env.TWELVEDATA_API_KEY,
    now,
    jobs: true,
  });
  await rt.start();
  logger.info({ providers: env.REALTIME_PROVIDERS, clockShiftMs: shift }, 'realtime started');
}

const server = createServer(createApp(sql, engine, env, rt));
const sockets = attachSockets(server, sql, engine, env.ALLOWED_ORIGINS, rt);
server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'haggle listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  for (const wss of sockets) for (const ws of wss.clients) ws.close(1012, 'restarting');
  server.close();
  await rt?.stop();
  await engine.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
