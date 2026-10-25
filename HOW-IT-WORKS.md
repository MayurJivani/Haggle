# How Haggle works

## The shape

A modular monolith in one npm workspace, following the FRC "app shape":

```
apps/server   Node + TypeScript: Express for a handful of routes, one WebSocket server, Postgres
  src/market    assets.ts (40 companies), events.ts (event templates and the session schedule), sim.ts (price model)
  src/trading   portfolio.ts (pure accounting in integer cents)
  src/session   engine.ts (clock, ticks, orders, results), store.ts (every SQL statement), ranking.ts
  src/app.ts    HTTP routes, security headers, static web build
  src/ws.ts     WebSocket auth, origin check, per-socket rate limit
apps/web      React + Vite + Tailwind, Lightweight Charts, Motion
```

One Node process owns the live session. That is deliberate: a single authority for the clock, the prices and every order is what makes the market fair and the ranking exact, and one process comfortably carries 500 players (see Load testing). Redis is not used; there is no second process to share state with. If the game ever needs several sessions in parallel, each session is already self-contained in `Engine`, so the next step is one process per session behind a router, not a shared cache.

## Session loop

`lobby` until `opens_at`, then `trading`, then `closing` for the last `CLOSING_SECONDS` (trading continues, the UI calls last orders), then `results` at `closes_at`. After `RESULTS_SECONDS` a new lobby opens and every connected player is dealt in. `phaseAt()` in `ranking.ts` derives the phase from the timestamps alone, so there is no state machine to drift. The organiser runs the room from the `/host` console (Bearer `ADMIN_TOKEN`, kept in that browser tab's session storage only): it polls `GET /api/host` once a second for the session, roster and news, shows a QR code of the site's own address for players to join, and calls `POST /api/admin/start` (open the bell), `/close` (ring the final bell now, at the current prices: the session's length becomes the ticks already played) and `/next` (skip the rest of the results). Open is disabled until someone has joined. A lobby with nobody in it never opens: the countdown restarts instead, so an always-on server does not write a full session of price history every cycle for an empty room.

Defaults: 2 min lobby, 10 min trading, 3 min results. All configurable in `.env`.

## The price model

Prices are integer cents, recomputed once per tick (1 s by default) by `MarketSim`:

```
log return = beta * market noise + sector noise + own noise + reversion + event drift
```

- **Noise** is seeded (`mulberry32`), Gaussian, clamped to 3 sigma. Draw order is fixed per tick (market, then each sector, then each asset), so adding or removing an event never shifts which random numbers the prices draw. That is also what lets the tests compare a run with and without one event and see exactly which companies it moved.
- **Reversion** pulls each price gently toward an anchor, so nothing random-walks off a cliff.
- **News lands in one move.** An event's whole impact hits on the tick the crier announces it, and the anchor moves with it. An earlier version drifted most of the move in over the following minute and pulled part of it back out later, so buying a good headline (or a panic dip) was a guaranteed trade. Now nothing about the price after the headline is predictable from the headline; `market.test.ts` holds that line.
- **Bounds**: a quiet tick moves at most 5% (50% on the tick an event lands), and every price stays between €0.50 and 8x its opening price.
- **Trading never moves prices.** Every player trades the same tape.

Because prices are a pure function of (seed, assets, schedule, tick), the whole market is reproducible. Set `MARKET_SEED` for an identical demo every time.

## Market events

`events.ts` holds 18 templates: company news (earnings beat or miss, product launch, probe, CEO exit, buyback, takeover rumour, drug approval, trial failure), sector moves (speculative boom, crackdown), macro factors (rate hike or cut, energy disruption, chip shortage, consumer confidence) and market-wide shocks (panic, rally). Each has a headline, description, severity, duration, impact range, jump share and persistence.

Factor events use per-asset sensitivities: a chip shortage scales by each company's `chips` sensitivity, so carmakers fall and chipmakers rise. A rate hike hurts growth stocks and helps banks.

`schedule()` decides the whole session's news from the seed before the bell: roughly one event every 7 to 12% of the session, exactly one market-wide shock somewhere in the middle, and a strong late twist before the close. Every player receives each event in the same broadcast, and every fired event and its per-company impact is stored in `market_events` and `market_event_effects`.

## Orders and accounting

All money is integer euro cents; quantities are whole shares. An order is a WebSocket message with a client-generated UUID:

1. The socket's token bucket admits it (burst 8, 4 per second; 50 strikes closes the socket).
2. Zod validates the shape. Unknown tickers, bad quantities and closed markets are rejected.
3. The player's orders run one at a time through a per-player promise chain.
4. `quote()` decides the fill against the in-memory book at the server's current price: no spending past cash, no selling past holdings, average-cost accounting with realised profit on sells.
5. `recordFill()` books it in one Postgres transaction: the trade row, the cash update, the position upsert and a ledger row. The database enforces the same rules a second time with `CHECK (cash_cents >= 0)`, `CHECK (quantity >= 0)` and `UNIQUE (participant_id, client_order_id)`, and the returned balances are compared with the in-memory mirror; any mismatch rolls the transaction back.
6. Only after commit does the in-memory book change and the fill go out.

A replayed order id hits the unique constraint and comes back as `duplicate`, so a retry after a dropped connection can never execute twice. The browser resends unconfirmed orders younger than 5 s on reconnect for exactly this reason.

Portfolio value = cash + sum(quantity x current price). Return = (value - €10,000) / €10,000. The amount is one constant, `STARTING_CASH` in `apps/server/src/trading/portfolio.ts`, which the web client imports. The leaderboard is recomputed every 2 s; the final ranking is computed once, at the same closing prices for everyone, ordered by value, then join time, then nickname, so it is deterministic.

### Awards

The winner is the highest final value. Two secondary awards: *Steadiest hand* (best mean-over-volatility of value samples every 10 ticks, among players who traded and finished up) and *Read the crier* (most value gained across the windows of severity 2 and 3 events). A "best percentage return" award is not offered: with everyone starting at €10,000 it is always the winner.

## Realtime

One WebSocket per tab at `/ws`, authenticated by the nickname cookie and an Origin check. Messages are compact JSON:

| Message | When | Size |
| --- | --- | --- |
| `hello` | on connect | full snapshot: session, 40 assets, price history down-sampled to 150 points, events, your book, board, results |
| `tick` | every tick | `{t,k,p:[40 prices]}`, about 250 bytes |
| `event` | when news fires | one event |
| `board` | every 2 s | top 10 serialised once, plus each player's own rank appended |
| `fill` / `reject` | per order | to that player's sockets only |
| `phase`, `results` | on transitions | |

A client that falls 512 KB behind skips ticks rather than queueing them; ticks carry absolute prices, so the next one catches it up. Heartbeat pings drop dead sockets after 20 s.

## Reconnects and restarts

- **Player reconnects**: the cookie identifies the player; `hello` restores the session, the tape so far, the news, the book and the board.
- **Server restarts mid-session**: the engine loads the live session row, rebuilds the market by replaying the seed to the current tick, and reloads every book from Postgres. Prices come back identical (the integration test checks this). The only thing lost is the in-memory value sampling for the two secondary awards, noted in code.

## Security

- Nickname-only accounts: a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` behind TLS with `TRUST_PROXY=true`); only its SHA-256 digest is stored.
- CSRF and cross-site WebSocket hijacking: every POST and every WebSocket upgrade must carry an `Origin` matching the host or `ALLOWED_ORIGINS`.
- Helmet with an explicit CSP; JSON bodies capped at 2 KB, WebSocket frames at 1 KB.
- Join rate limit per IP (generous by default, because a hosted event puts a room behind one NAT).
- Admin token compared with `timingSafeEqual`; unset disables the admin routes.
- Config is validated at startup with Zod and the process exits on bad config.

## Database

Migrations live in `apps/server/src/db/migrations/*.sql` and run at startup in filename order inside a transaction holding an advisory lock (`schema_migrations` records what ran). Add a change as the next numbered file; never edit an applied one.

Tables: `users`, `assets` (upserted from code at boot), `sessions` (one live at a time, enforced by a partial unique index), `participants` (cash), `positions`, `trades` (executed orders), `ledger` (every cash movement with the balance after), `price_history` (every tick, flushed in batches), `market_events` and `market_event_effects`, `leaderboard_snapshots` (every 30 ticks and at the close), `results` (final rank, value, return and the shareable stats).

## Monitoring

- `GET /healthz`: database reachable and the tick loop on time (503 when lagging more than 5 s). Used by the Docker health check.
- `GET /metrics` (Bearer `ADMIN_TOKEN`): Prometheus text with sockets, players, ticks, tick lag, orders by result, order latency, bytes out, database errors, event loop delay p99 and heap.
- Structured pino logs; tokens and cookies are never logged.

## Load testing

`apps/server/scripts/loadtest.ts` drives real clients over HTTP and WebSocket: every bot joins through `/api/join`, connects, trades at random every few seconds, sends 5% of its orders twice with the same id, and halfway through drops 10% of the bots and reconnects them, checking the restored book matches.

Run it against its own server so the join limit and lobby suit it:

```bash
JOIN_RATE_LIMIT=100000 LOBBY_SECONDS=600 TRADING_SECONDS=150 ADMIN_TOKEN=<token> PORT=4391 npm start
TARGET=http://localhost:4391 CLIENTS=500 DURATION=90 ADMIN_TOKEN=<token> npm run loadtest
```

It prints order latency, the spread between the first and last client receiving each tick, duplicate and reconnect checks, and exits non-zero on any double execution, book mismatch or server error.

Result on a laptop (one Node process, Postgres 16 in Docker), 500 clients for 90 s:

| Measure | Result |
| --- | --- |
| Fills / rejections | 10,800 / 2,010 (cash, shares and duplicates) |
| Order round trip | p50 4 ms, p95 6 ms, p99 12 ms |
| Tick fan-out spread across 500 clients | p50 9 ms, p95 14 ms |
| Orders sent twice | 616, executed twice: 0 |
| Reconnects | 50, book mismatches: 0 |

Afterwards, every participant's ledger summed to its cash, every position matched its trades, and every stored final value equalled cash plus holdings at the stored closing prices.

## Deployment

- **Docker Compose**: `docker compose up --build` runs Postgres and the app; see the README.
- **Jinx** (the FRC box, no Docker): `deploy/deploy.sh` builds locally from the committed tree, installs `deploy/haggle.caddy` with validate-then-restore, rsyncs the builds and restarts the `haggle` systemd unit (`deploy/haggle.service`). The one-time setup (database, env file, unit, tunnel hostname) is listed at the top of the script.
