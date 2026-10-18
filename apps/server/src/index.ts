import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connect, migrate } from './db/db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { Engine } from './session/engine.js';
import { attachSockets } from './ws.js';

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
    seed: env.MARKET_SEED,
  },
  logger,
);
await engine.start();

const server = createServer(createApp(sql, engine, env));
const wss = attachSockets(server, sql, engine, env.ALLOWED_ORIGINS);
server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'haggle listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  engine.stop();
  for (const ws of wss.clients) ws.close(1012, 'restarting');
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
