<div align="center">

<img src="docs/screenshots/home.png" alt="Haggle home page with the live tape of company prices, today's movers and the round timetable" width="100%">

# Haggle

**A live stock market for the whole room. Same prices, same news, one clock. The fattest purse at the closing bell wins.**

[Play it](https://haggle.futile.studio) · [How it works](HOW-IT-WORKS.md) · [Futile Studio](https://futile.studio)

[![live](https://img.shields.io/badge/live-haggle.futile.studio-0d0b19?style=flat-square&labelColor=0b0b0b)](https://haggle.futile.studio)
![React](https://img.shields.io/badge/React-19-0b0b0b?style=flat-square&logo=react)
![Node](https://img.shields.io/badge/Node-22-0b0b0b?style=flat-square&logo=nodedotjs)
![Postgres](https://img.shields.io/badge/Postgres-16-0b0b0b?style=flat-square&logo=postgresql)
![last commit](https://img.shields.io/github/last-commit/MayurJivani/Haggle?style=flat-square&labelColor=0b0b0b&color=0d0b19)

</div>

> **Futile Studio · FS-003** · Games, market game · Live since Oct 2026

## How a round goes

Everyone joins with a nickname and gets €10,000 of virtual money. When the bell rings, the whole room trades the same 75 real companies (five in each of 15 sectors) at the same simulated prices. News lands on every screen at the same moment, quarterly reports move the stocks, and the clock turns red for last calls. When the market closes, cash plus shares decides the ranking. A round takes about 15 minutes, and then the next one begins on the same market, which never resets between rounds.

| Phase | Length | What happens |
| --- | --- | --- |
| Lobby | 2 min | Join, read the prices, nothing trades |
| Trading | 10 min | Buy and sell at the live price while news hits |
| Last calls | 60 s | Still trading, the clock goes red |
| Results | 3 min | Final ranking, awards and a replay of the race |

Company names are real. Every price, headline, financial report and euro in the classic game is simulated, and none of it is advice.

## Ways to play

- **The main market** at `/play`: one shared competition that loops all day.
- **Custom games** at `/rooms`: pick your own rules, length and up to 150 companies, and share an eight-letter code with friends.
- **Events** at `/host`: put the console on a big screen. Players scan a QR code to join, and the organiser opens the bell, closes the market early or starts the next round.
- **Haggle RealTime (beta)** at `/realtime`: see below.

## Haggle RealTime (beta)

The second mode swaps the simulation for the real market. You paper-trade real stocks, ETFs and indices at real prices, on each exchange's own clock: when the NYSE opens at 09:30 in New York, so does the game. Ten exchanges keep their own hours, lunch breaks, holidays and early closes, in their own time zones. That covers NYSE, Nasdaq, London, Xetra, Euronext, Tokyo, Hong Kong, Shanghai, Toronto and the ASX.

- More than 56,000 instruments to search and browse by exchange, sector, size and session.
- Market and limit orders that fill at the live bid and ask, with fractional shares.
- Live prices over WebSockets, real candle charts for a day, a year or the whole history, and a watchlist.
- Open, weekly and monthly competitions with leaderboards, public profiles and follows.
- Every price says what it is (real time, delayed, stale or last close). With no price, the screen shows none.

RealTime stays off until a market data provider is configured. [docs/realtime.md](docs/realtime.md) covers the providers, their licences, the fill rules and how to test it outside market hours.

## Stack

React, Vite and Tailwind on the front, with Lightweight Charts and Motion. Node and TypeScript on the back, with Express, one WebSocket server and Postgres. One process owns the market, so the clock, the prices and every order have a single authority. Money is kept in whole cents, so no rounding error can create or lose a cent.

## Running it locally

**Docker Compose** (Postgres included):

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and ADMIN_TOKEN
docker compose up --build
```

Open http://localhost:4371. The first lobby opens on boot and rounds loop by themselves.

**Local development** (Node 22+, Postgres 14+):

```bash
npm install
cp .env.example .env    # point DATABASE_URL at your database, add ALLOWED_ORIGINS=http://localhost:5273
npm run dev             # API on :4371, web on :5273
```

Migrations run at startup.

To try RealTime without an API key, use the development feed. Its prices are generated and every screen says so, and it refuses to start in production:

```bash
REALTIME_PROVIDERS=dev REALTIME_CLOCK=2026-11-24T15:10:00Z npm run dev
```

## Configuration

Every setting, with what it does and its default, is in [.env.example](.env.example). The ones you will touch first:

- `DATABASE_URL`: the Postgres the server connects to (local dev).
- `POSTGRES_PASSWORD`: password for the bundled Postgres (Docker Compose only).
- `ADMIN_TOKEN`: the host code for `/host` and `GET /metrics`. Unset, both answer 404.
- `LOBBY_SECONDS`, `TRADING_SECONDS`, `CLOSING_SECONDS`, `RESULTS_SECONDS`, `TICK_MS`: round timing.
- `MAX_PLAYERS`, `MAX_ROOMS`, `MARKET_SEED`: session size, custom room cap, a fixed seed for demos.
- `ALLOWED_ORIGINS`, `TRUST_PROXY`, `JOIN_RATE_LIMIT`: network and rate limits.
- `REALTIME_PROVIDERS` plus `ALPACA_*` and `TWELVEDATA_*`: market data for RealTime.

## Running an event

Open `/host` on the organiser's laptop and enter the host code (`ADMIN_TOKEN`). The same controls work as plain API calls:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4371/api/admin/start   # also /close and /next
```

## Tests

```bash
npm test                                                                 # unit tests: accounting, market, calendars, fills
TEST_DATABASE_URL=postgres://user:pass@host/db npm test -w apps/server   # plus the Postgres integration tests
npm run loadtest                                                         # 1,000 simulated players
```

On one laptop, 1,000 simulated players traded for two minutes with a p95 order round trip of 5 ms. No order ran twice and no reconnect lost a position. The full numbers are in [HOW-IT-WORKS.md](HOW-IT-WORKS.md#load-testing).

## More reading

- [HOW-IT-WORKS.md](HOW-IT-WORKS.md): architecture, the price model, exact accounting, restart recovery, security, deployment.
- [docs/realtime.md](docs/realtime.md): Haggle RealTime.
- [docs/](docs/): market research, model calibration and the scenario library.

## Licence

No licence file yet, all rights reserved.

---

<p align="center"><sub>Built by <a href="https://github.com/MayurJivani">Mayur Jivani</a> at <a href="https://futile.studio">Futile Studio</a>. Everything is futile. Do it anyway.</sub></p>
