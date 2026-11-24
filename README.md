# Haggle

![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20Node%20%C2%B7%20Postgres-ffb020) ![Realtime](https://img.shields.io/badge/realtime-WebSockets-7c83ff) ![Players](https://img.shields.io/badge/players-1000%20per%20session-3ddc84)

A live stock market for the whole room. Up to 1,000 players join with a nickname, get €10,000 of virtual money at the opening bell, research and trade 75 real companies (five in each of 15 sectors) at simulated prices in one market that carries on from round to round, read news that hits every screen at once, and finish ranked by portfolio value. A full round runs in about 15 minutes. Anyone can also set up a custom game with friends at `/rooms`: its own rules, leaderboard and choice of up to 150 companies, on the same shared market.

Virtual money only. Company names are real; every price, headline, financial report and euro is simulated.

## Haggle RealTime (beta)

A second mode at `/realtime`: paper-trade real stocks, ETFs and indices at real market prices, on each exchange's real clock. NYSE, Nasdaq, LSE, Xetra, Euronext, Tokyo, Hong Kong, Shanghai, Toronto and ASX each open, pause for lunch, close early and take holidays on their own calendars, in their own time zones. Players get €10,000 of virtual cash, place market and limit orders against live bid and ask, and compete in open, weekly and monthly seasons. Every price shows whether it is real time, delayed or stale; when there is no price, none is shown.

RealTime is off until a market data provider is set (`REALTIME_PROVIDERS` in `.env`; Alpaca and Twelve Data are supported). [docs/realtime.md](docs/realtime.md) covers providers, licensing, fill rules and how to test it outside market hours.

## Run it

**Docker Compose** (Postgres included):

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and ADMIN_TOKEN
docker compose up --build
```

Open http://localhost:4371 for the home page; the main market is at `/play`. The first lobby opens on boot and sessions loop by themselves.

**Local development** (Node 22+, any Postgres 14+):

```bash
npm install
cp .env.example .env    # point DATABASE_URL at your database, add ALLOWED_ORIGINS=http://localhost:5273
npm run dev             # API on :4371, web on :5273
```

Migrations run automatically at startup.

## Hosting an event

Open `/host` on the organiser's laptop or the room's big screen and enter the host code (`ADMIN_TOKEN`). The console shows a QR code players scan to join, the countdown, the room count, the roster and the news, and runs the round: open the bell now, close the market early, start the next round. The same actions are plain API calls:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4371/api/admin/start   # also /close and /next
```

## Tests

```bash
npm test                                                        # accounting, market and exploit tests, financials, chart history
TEST_DATABASE_URL=postgres://user:pass@host/db npm test -w apps/server   # plus the Postgres integration test
npm run loadtest                                                # 1,000 simulated players, see HOW-IT-WORKS.md
```

## More

[HOW-IT-WORKS.md](HOW-IT-WORKS.md) covers the architecture, the price model, how trades stay exact, restart recovery, monitoring, load testing and deployment.
