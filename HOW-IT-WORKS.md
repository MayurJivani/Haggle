# How Haggle works

## The shape

A modular monolith in one npm workspace, following the FRC "app shape":

```
apps/server   Node + TypeScript: Express for a handful of routes, one WebSocket server, Postgres
  src/market    assets.ts (75 companies, five per sector), fundamentals.ts (simulated reports, fair value, P/E),
                events.ts (news templates and the competition schedule), sim.ts (price model)
  src/trading   portfolio.ts (pure accounting in integer cents)
  src/session   engine.ts (clock, ticks, checkpoints, orders, results), store.ts (every SQL statement), ranking.ts
  src/app.ts    HTTP routes, security headers, static web build
  src/ws.ts     WebSocket auth, origin check, per-socket rate limit
apps/web      React + Vite + Tailwind, Lightweight Charts, Motion
  src/lib       game.ts (socket and store), series.ts (chart history), research.ts (P/E, valuation ranks)
```

One Node process owns the market. That is deliberate: a single authority for the clock, the prices and every order is what makes the market fair and the ranking exact, and one process comfortably carries 500 players (see Load testing). Postgres is the durable truth; Redis is not used, because there is no second process to coordinate with, and nothing durable may live only in a cache anyway. A second process on the same database refuses to start (see The persistent market).

There are two lifetimes. **The market** lives forever: one set of prices, one news history, one set of financial reports, carried across every competition and restart. **A competition** (a "session" in the code) lives ten minutes or so: its players, their cash and positions, its leaderboard and results. Starting a competition resets the players' accounts, never the market.

## Session loop

`lobby` until `opens_at`, then `trading`, then `closing` for the last `CLOSING_SECONDS` (trading continues, the UI calls last orders), then `results` at `closes_at`. After `RESULTS_SECONDS` a new lobby opens and every connected player is dealt in. `phaseAt()` in `ranking.ts` derives the phase from the timestamps alone, so there is no state machine to drift. The organiser runs the room from the `/host` console (Bearer `ADMIN_TOKEN`, kept in that browser tab's session storage only): it polls `GET /api/host` once a second for the session, roster and news, shows a QR code of the site's own address for players to join, and calls `POST /api/admin/start` (open the bell), `/close` (ring the final bell now, at the current prices: the session's length becomes the ticks already played) and `/next` (skip the rest of the results). Open is disabled until someone has joined. A lobby with nobody in it never opens: the countdown restarts instead, so an always-on server does not write a full session of price history every cycle for an empty room.

Defaults: 2 min lobby, 10 min trading, 3 min results. All configurable in `.env`.

## The price model

Prices are integer cents, recomputed once per tick (1 s by default) by `MarketSim`, and only while a competition is trading. Between competitions the market is closed and does not move.

```
log return = beta * market noise + sector noise + own noise + pull toward the anchor  (bounded per tick)
           + the whole move of any story published on this tick                      (bounded per story and per window)
anchor     = fair value (from the reports) + sentiment (lasting) + transient (temporary)
```

- **Noise** is seeded (`mulberry32`), Gaussian, clamped to 3 sigma, with each company's own volatility, so steady companies move less than risky ones. Draw order is fixed per tick (market, then each sector, then each company), so a story never shifts which random numbers the rest of the market draws; the tests compare runs with and without one story and see exactly what it moved.
- **News is a jump, never a drift.** A story's whole move lands on the tick it is published, and the anchor moves with it, so the pull toward the anchor adds nothing of its own afterwards. The share the template calls lasting goes into `sentiment` (half-life about twenty competitions); the rest into `transient` (half-life about five). Both fade slowly on purpose: a fade quick enough to see inside one competition would be a trade anyone could take off the headline. Measured over 400 simulated competitions, buying every positive headline wins 47% of the time over two minutes and 44% over ten, with a slightly negative mean; the stories are worth reading, not chasing.
- **Fair value** comes from the company's reports (see Financials) and moves only when a report is filed. A new fair value never jumps the price: the gap moves into sentiment and fades, so prices drift toward what the numbers justify over many competitions.
- **Market stress** rises with a market-wide shock and decays; it scales market noise, so volatility clusters after a crash the way it does in real markets.
- **Bounds**: a quiet tick moves at most 5%; one story at most 30% on one company; stacked stories at most 35% within any 60-tick window (and the anchor moves only by what actually landed, so a clipped story leaves no catch-up drift); a price stays within e^1 of its anchor, and between €0.50 and €1,000,000.
- **Trading never moves prices.** Nothing about orders reaches `MarketSim`. Every player trades the same tape, so buying a stock hard cannot push it up, and a supply-and-demand mode would need its own liquidity model behind its own switch.

The simulation's whole state (every log price, sentiment, transient, fair value, window sum, the stress level and the RNG's 32-bit state) round-trips through `state()`. That is what a checkpoint stores, and resuming from it replays the exact same tape.

## Market events

`events.ts` holds about forty story templates in three categories: the economy (rate decisions, inflation, growth revisions, recession fears, currency, consumer confidence and spending, market-wide shocks), sectors (chip shortages, data-centre spending, oil spikes and slumps, bank stress, tech regulation, shipping disruption, renewables, defence budgets, drug fast-tracks, speculative frenzies, pricing reviews) and companies (earnings beats and misses, record profit with a cut outlook, margin warnings, launches, executive exits, investigations, rivals, contract wins and losses, buybacks, takeover rumours, approvals, trial failures, recalls). Each has headline and briefing variants with figures filled in, a severity, a lasting share, and some have follow-ups (an investigation is later cleared or fined; a takeover rumour is confirmed or collapses).

Cross-sector effects come from per-company sensitivities to ten factors (rates, oil, chips, consumer, data centres, credit, supply chains, growth, the euro, tech regulation), not from rules in the UI: dear oil lifts producers and grounds airlines, a rate hike pressures expensive growth stocks and helps banks, a chip shortage lifts chipmakers and hurts carmakers, a shipping disruption hurts manufacturers and helps container lines. Every company reacts with its own jitter, and 15% of company and sector stories turn out to be priced in: the reaction is muted or even reversed. Copy reports what happened; it never names a winner, and the client is never sent a story's price impact or any company's sensitivities.

Earnings stories file the company's next quarterly report: consensus expects last year's quarter grown at trend, the story's surprise sets the actual EPS, and revenue gets its own surprise. The report changes trailing EPS and so the fair value. A beat can still fall (the record-profit, cut-outlook story), and one company files at most one report per competition.

When the bell rings, `schedule()` decides the competition's news from its seed (roughly one story every 7 to 12% of the competition, one market-wide shock in the middle, a strong late twist, and follow-ups) and `openSession()` stores the whole schedule, unpublished, in the same transaction that opens the competition. Unpublished stories never leave the server. Each is published on its tick, to every player in the same broadcast, and marked `published` at the next checkpoint; stories still waiting when a competition closes early are marked `cancelled` and never carry over. Every story's per-company impact is stored in `market_event_effects` for audit.

## The persistent market

- **First boot.** If there is no checkpoint, the market is seeded once: prices from the last competition played before the market became persistent if there is one (else the seed prices in `assets.ts`), the RNG from `MARKET_SEED` or a fixed constant, so a new install's first market is the same everywhere. Simulated reports are generated deterministically per company and inserted once. Companies added to `assets.ts` later are listed at their seed price on the next boot.
- **Checkpoints.** Every 10 ticks, and at every close, one transaction writes the price rows since the last checkpoint, marks the stories that landed as published, inserts any reports they filed, and stores the new state with its sequence number. Checkpoints run strictly one after another; a failed one is folded into the next, so nothing is dropped while the database is away, and `/healthz` turns 503 when more than 120 ticks are not yet durable.
- **One writer.** The engine holds a Postgres advisory lock for its whole life and refuses to start without it. Each checkpoint also takes a transaction lock and checks that the stored head is the sequence it built on; if it is not, the engine fences itself (stops advancing the market) rather than fork it.
- **Restarts.** A restarted engine loads the latest checkpoint and every story that can still move a price after it, then replays the ticks the clock says should have happened. Replay is exact: the same state, the same RNG, the same stored stories (with their exact effect fractions, not rounded basis points). A story that landed before the checkpoint is inside the state and is never applied again; one that landed after it lands again on the same tick with the same move, which is what happened the first time. Event ids are durable, and `MarketSim.load()` ignores an id it has seen, so loading or retrying a story never doubles it.
- **Competitions.** The bell records the market's sequence number and every opening price on the competition, and the change column is measured from there. The close records the closing prices, which are also where the next competition opens.

## Financials

`fundamentals.ts` gives every company twelve quarters of simulated results (revenue, net income, EPS and the consensus estimate it was measured against), scaled to the real company's size, margin and growth so a bank looks like a bank. They are not reported figures and every screen says so; the `source` column allows real reported data to be loaded later without a schema change. Annual figures are always the sum of a fiscal year's four quarters and are only shown for complete years.

- **Trailing EPS** is the sum of the last four quarters, and only when they are consecutive: with a quarter missing, trailing EPS, P/E and fair value are `N/A` rather than a guess.
- **Simulated-price P/E** is the current game price over trailing EPS, recomputed every tick on the client; `N/M` for zero or negative earnings.
- **Fair value** is trailing EPS times a justified P/E: the geometric mean of a configured sector multiple and the company's own long-run multiple, raised for earnings growth (capped at 40%) and lowered for beta. Loss-makers are valued on sales per share at a discounted P/S. The multiples are configuration, never read off current prices, because a fair value that rose whenever prices rose would be exactly the feedback loop the price model must not have. The client shows the price against fair value, the P/E against the sector's median at current prices, and a rank across the listing, all labelled as simulated estimates and not advice; several profitable, growing companies seed well above their fair value.

## Orders and accounting

All money is integer euro cents; quantities are whole shares. An order is a WebSocket message with a client-generated UUID:

1. The socket's token bucket admits it (burst 8, 4 per second; 50 strikes closes the socket).
2. Zod validates the shape. Unknown tickers, bad quantities and closed markets are rejected.
3. The player's orders run one at a time through a per-player promise chain.
4. `quote()` decides the fill against the in-memory book at the server's current price: no spending past cash, no selling past holdings, average-cost accounting with realised profit on sells.
5. `recordFill()` books it in one Postgres transaction: the trade row, the cash update, the position upsert and a ledger row. The database enforces the same rules a second time with `CHECK (cash_cents >= 0)`, `CHECK (quantity >= 0)` and `UNIQUE (participant_id, client_order_id)`, and the returned balances are compared with the in-memory mirror; any mismatch rolls the transaction back.
6. Only after commit does the in-memory book change and the fill go out.

A replayed order id hits the unique constraint and comes back as `duplicate`, so a retry after a dropped connection can never execute twice. The browser resends unconfirmed orders younger than 5 s on reconnect for exactly this reason.

Portfolio value = cash + sum(quantity x current price). Profit = value - starting capital; return = profit / starting capital. A new competition deals `STARTING_CASH` (€10,000, in `apps/server/src/trading/portfolio.ts`, the one place it is set) and records it in its config as `startingCash`; every return, award threshold and result card is computed against the amount recorded for that competition, so changing the constant never rewrites an old result. Competitions from before the amount was recorded were backfilled from their own grant ledger rows (they were €1,000). The leaderboard is recomputed every 2 s; the final ranking is computed once, at the same closing prices for everyone, ordered by value, then join time, then nickname, so it is deterministic.

Cost basis is average cost: a buy adds its cost, a sale removes the sold shares' share of it (exactly the remainder when the position is closed, so no cent strands) and books the difference as realised profit into cash. Realised profit is therefore already in the portfolio value and is shown, never added again. In the browser every screen (top bar, holdings, position panel, results) derives its figures from one function, `valuation()` in `apps/web/src/lib/portfolio.ts`, applied to the book the server sends with each fill and the latest tick, so a trade shows everywhere at once without a reload (`portfolio.test.ts` drives the store with a fill, a tick and a partial sale). A custom room may deal its own purse; returns use the amount that room recorded.

### Awards

The winner is the highest final value. Two secondary awards: *Steadiest hand* (best mean-over-volatility of value samples every 10 ticks, among players who traded and finished up) and *Read the crier* (most value gained across the windows of severity 2 and 3 events). A "best percentage return" award is not offered: with everyone in a competition starting from the same purse it is always the winner.

## Realtime

One WebSocket per tab at `/ws`, authenticated by the nickname cookie and an Origin check. Messages are compact JSON:

| Message | When | Size |
| --- | --- | --- |
| `hello` | on connect | session, prices, opening prices, the market's sequence number, the 40 latest stories, your book, board, results (6 KB, up to about 20 KB once 40 stories are stored) |
| `tick` | every tick | `{t,k,at,p:[75 prices]}`, about 500 bytes; `k` is the market sequence number |
| `event` | when a story is published | one story, no price impact |
| `fund` | when a report is filed | that company's new summary |
| `regime` | when market stress changes band | |
| `board` | every 2 s | top 10 serialised once, plus each player's own row appended; every row carries value, cash, return and trades, all valued at one tick (`at`) |
| `fill` / `reject` | per order | to that player's sockets only; a fill carries the trade record |
| `phase`, `results` | on transitions | |

The listing and every company's summary come from `GET /api/market` (served with an ETag, so a reconnect is a 304), reports from `GET /api/companies/:ticker`, price history from `GET /api/prices/:ticker?range=` and the player's own trades from `GET /api/me/trades`. History is bucketed on the server (`date_bin`, at most 600 bars per answer, OHLC with the last sequence number per bar) and cached for a second, so a room opening the same chart at once costs one query; research routes are rate limited per player cookie, not per IP, since a hosted room shares one address.

A client that falls 512 KB behind skips ticks rather than queueing them; ticks carry absolute prices, so the next one catches it up. Heartbeat pings drop dead sockets after 20 s.

**Charts.** `lib/series.ts` holds history apart from the chart component, so it survives remounts and switching companies. A chart fetches the stored bars for its range, folds in the ticks the tab has seen since that answer, then folds each live tick in: a tick at or below the newest bar's sequence number is a duplicate and is dropped, one inside the newest bar's bucket updates it, a later one appends. Nothing ever replaces or removes stored points (`series.test.ts` pushes 800 live ticks through and checks every stored bar is untouched). Where the market was closed for more than three buckets the line breaks rather than drawing a slope across hours nobody traded. Ranges are offered only when the stored data can fill them; All runs from the first stored price to now, across competitions and restarts. Panning into the past keeps the view while prices arrive, with a Back to live control that shows when newer prices are waiting.

## Reconnects and restarts

- **Player reconnects**: the cookie identifies the player; `hello` restores the competition, prices, news, book and board, the client refetches its trades, and any chart refetches its history, so the gap is filled from the server, never interpolated. Orders sent just before the drop are resent with the same id and execute at most once.
- **Server restarts**: see The persistent market. Books come back from Postgres, the market from its checkpoint plus an exact replay. The only thing lost is the in-memory value sampling for the two secondary awards, noted in code.

## Security

- Nickname-only accounts: a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` behind TLS with `TRUST_PROXY=true`); only its SHA-256 digest is stored.
- CSRF and cross-site WebSocket hijacking: every POST and every WebSocket upgrade must carry an `Origin` matching the host or `ALLOWED_ORIGINS`.
- Helmet with an explicit CSP; JSON bodies capped at 2 KB, WebSocket frames at 1 KB.
- Join rate limit per IP (generous by default, because a hosted event puts a room behind one NAT).
- Admin token compared with `timingSafeEqual`; unset disables the admin routes.
- Config is validated at startup with Zod and the process exits on bad config.

## Database

Migrations live in `apps/server/src/db/migrations/*.sql` and run at startup in filename order inside a transaction holding an advisory lock (`schema_migrations` records what ran). Add a change as the next numbered file; never edit an applied one. `002_persistent_market.sql` extends the original schema rather than duplicating it.

The market: `assets` (upserted from code at boot, with exchange and industry), `market_checkpoints` (sequence number and state), `market_prices` (every tick of every company, keyed by company and sequence, indexed by company and time), `market_events` (every story with its status, the tick it lands on and the report it files) and `market_event_effects` (its per-company move), `financial_reports` (one row per company and fiscal quarter, with source and timestamps).

A competition: `sessions` (one live house competition at a time, enforced by a partial unique index, plus any number of custom rooms with a code, name, host and visibility; config including `startingCash`, the opening sequence number and opening and closing prices), `participants` (cash), `positions`, `trades` (executed orders), `ledger` (every cash movement with the balance after), `leaderboard_snapshots` (every 30 ticks and at the close), `results` (final rank, value, return and the shareable stats). The original per-competition `price_history` table is kept read-only for competitions played before the market became persistent.

## Rooms

A custom room is a competition like the house one, with a host and its own rules: name and description, public (listed at `/rooms`) or private (reached only by its eight-letter code), most traders, starting purse, trading length, a scheduled bell or one the host rings, whether people may join after the bell, whether traders may open each other's portfolios while trading, and whether every portfolio is shown on the results page. A private room's standings and results are shown only to its own traders unless the host makes them public. Everything is validated on the server (`POST /api/rooms`, Zod), creation is rate limited per player, a host may run three rooms at once and `MAX_ROOMS` caps them all.

- **One market, many competitions.** Prices, news and reports stay global; cash, positions, trades, leaderboards and results stay per competition, because each room is a row in `sessions` and every book hangs off its `participants`. The market ticks while any competition is trading. The first one to open on an idle market anchors the tick grid; a room that opens while it runs is aligned to the same grid, so every room trades exactly the same tape. Each room's news schedule is added to that tape, so overlapping rooms see each other's stories (the news is denser while several rooms trade at once, noted in code).
- **Frozen results.** A room's last tick captures every price on that tick. From then on its orders are refused and its ranking, results and closing prices use only those prices, however long the market keeps running for other rooms. A restart after a room's last tick but before its results reads the close back from `market_prices`.
- **Sockets.** A socket joins one competition (`/ws?room=CODE`, none = the house). Ticks, news, reports and the regime go to every socket; phase, board, results and fills go only to that competition's sockets, so a second tab in another room never sees them.
- **Joining.** The unique `(session, user)` participant row means a reconnect, a second tab or a repeated request never deals a second purse, and a book from one room never enters another. Nickname accounts cannot stop one person opening several accounts; the per-IP join limit only slows it.
- **The host.** Only the host may ring a manual bell or close the market early. If the host disconnects the room carries on by its clock; a manual room nobody starts is closed with no results after 24 hours.
- **Leaderboard.** `GET /api/sessions/:id/board` returns every trader at one valuation time (cached a second); `GET /api/sessions/:id/portfolio/:participant` returns a rival's book only where the room allows peeking, and only to its own traders.

## Monitoring

- `GET /healthz`: database reachable, the tick loop on time, the market durable (503 when lagging more than 5 s, more than 120 ticks not yet checkpointed, or the engine fenced). Used by the Docker health check.
- `GET /metrics` (Bearer `ADMIN_TOKEN`): Prometheus text with sockets, players, ticks, tick lag, checkpoint lag and age, checkpoint failures, stories published, orders by result, order latency, bytes out, database errors, event loop delay p99 and heap.
- Structured pino logs; tokens and cookies are never logged.

## Load testing

`apps/server/scripts/loadtest.ts` drives real clients over HTTP and WebSocket: every bot joins through `/api/join`, connects, trades at random every few seconds, sends 5% of its orders twice with the same id, opens price charts and company pages every 15 s or so, and halfway through drops 10% of the bots and reconnects them, checking the restored book matches. It also checks that every published story reached every connected bot.

Run it against its own server and database so the join limit and lobby suit it:

```bash
NODE_ENV=production JOIN_RATE_LIMIT=100000 LOBBY_SECONDS=600 TRADING_SECONDS=300 ADMIN_TOKEN=<token> PORT=4391 npm start
TARGET=http://localhost:4391 CLIENTS=500 DURATION=120 ADMIN_TOKEN=<token> npm run loadtest
```

It exits non-zero on any double execution, book mismatch, missed story, failed research request or server error.

Result on a laptop (one Node process, Postgres 16 in Docker), 500 clients for 120 s, 120 companies, October 2026:

| Measure | Result |
| --- | --- |
| Fills / rejections | 16,683 / 388 (cash and shares) |
| Order round trip | p50 4 ms, p95 7 ms, p99 12 ms |
| Tick fan-out spread across 500 clients | p50 7 ms, p95 11 ms |
| Chart and company requests | 4,235, p50 2 ms, p95 4 ms, p99 6 ms, 0 errors |
| Orders sent twice | 907, executed twice: 0 |
| Reconnects | 50, book mismatches: 0 |
| Stories missed by a connected client | 0 |
| Server | 0 database errors, checkpoint lag 0, event loop delay p99 23 ms, heap 49 MB |

Afterwards every participant's ledger summed to its cash. This covers trading, ticks, news, chart traffic and reconnects together on one machine; it has not been run across a real network or through Cloudflare.

## Deployment

- **Docker Compose**: `docker compose up --build` runs Postgres and the app; see the README.
- **Jinx** (the FRC box, no Docker): `deploy/deploy.sh` builds locally from the committed tree, installs `deploy/haggle.caddy` with validate-then-restore, rsyncs the builds and restarts the `haggle` systemd unit (`deploy/haggle.service`). The one-time setup (database, env file, unit, tunnel hostname) is listed at the top of the script.

## Audit: the October 2026 upgrade

What was wrong before the persistent market, and what replaced it.

- **The headline exploit.** The price model landed only part of a story's move on the tick the crier called it and drifted the rest in over the next 15 to 90 seconds, then pulled part of it back out, while the crier showed each company's exact impact. Buying a good headline (or a panic dip) was a guaranteed trade. Nothing was applied twice; the move was simply announced before it happened. Now the whole move lands on the published tick, the fade is slow and two-part, clients never see an impact, and `market.test.ts` holds both the jump and the bound on what follows. A one-file hotfix of the old model shipped first.
- **Prices reset every competition.** Each session rebuilt the market from the seed prices. Now one market persists across competitions and restarts.
- **Restart after an early close changed the news.** The schedule was regenerated from the seed with the shortened length, so a restart between the early bell and the results replayed a different tape. Schedules are now stored when the bell rings and never regenerated.
- **Charts lost and invented history.** `hello` down-sampled the session to 150 points and the client interpolated between them, and a chart only ever showed the current session. History now comes from stored bars, live ticks only extend it, and gaps stay gaps.
- **The crier covered the order ticket.** The banner was an absolute overlay on the trading floor; on phones it sat over whatever tab was open. It is now a reserved row of the layout.
- **The universe.** 40 companies in 8 sectors became 120 in 15, with exchanges, industries and simulated financials, then exactly five per sector (75), enforced by a test.
