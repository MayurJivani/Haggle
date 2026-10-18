# Live Bazar

![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20Node%20%C2%B7%20Postgres-ffb020) ![Realtime](https://img.shields.io/badge/realtime-WebSockets-7c83ff) ![Players](https://img.shields.io/badge/players-500%20per%20session-3ddc84)

A live stock market for the whole room. Up to 500 players join with a nickname, get €1,000 of virtual money at the opening bell, trade 40 real companies at simulated prices, react to news that hits every screen at once, and finish ranked by portfolio value. A full event runs in about 15 minutes.

Virtual money only. Company names are real; every price, headline and euro is simulated.

## Run it

**Docker Compose** (Postgres included):

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and ADMIN_TOKEN
docker compose up --build
```

Open http://localhost:4371. The first lobby opens on boot and sessions loop by themselves.

**Local development** (Node 22+, any Postgres 14+):

```bash
npm install
cp .env.example .env    # point DATABASE_URL at your database, add ALLOWED_ORIGINS=http://localhost:5273
npm run dev             # API on :4371, web on :5273
```

Migrations run automatically at startup. To open the bell early during a hosted event:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4371/api/admin/start
```

## Tests

```bash
npm test                                                        # accounting, market, events, phases
TEST_DATABASE_URL=postgres://user:pass@host/db npm test -w apps/server   # plus the Postgres integration test
npm run loadtest                                                # 500 simulated players, see HOW-IT-WORKS.md
```

## More

[HOW-IT-WORKS.md](HOW-IT-WORKS.md) covers the architecture, the price model, how trades stay exact, restart recovery, monitoring, load testing and deployment.
