# Haggle RealTime

Paper trading on real market data, on the real world clock. It lives at `/realtime`, beside the classic
game, and shares only the player account (the `users` table and the session cookie). Everything else is in
`rt_*` tables (migration `005_realtime.sql`) and `apps/server/src/realtime/`.

RealTime is off until `REALTIME_PROVIDERS` is set. With it off, `/api/rt/*` answers 503 and the classic
game runs unchanged.

## Layout

| File | Job |
|---|---|
| `calendar.ts` | Exchange sessions, holidays, early closes, lunch breaks, DST through IANA zones |
| `catalogue.ts` | Instrument catalogue: Twelve Data reference lists (stocks, ETFs, indices) plus Nasdaq screener sector and market cap for US listings, refreshed daily |
| `providers/*` | `Provider` interface, Alpaca, Twelve Data, the dev adapter, and `Feeds` (routing and fallback) |
| `market.ts` | Shared quote cache, subscriptions, polling, staleness, ECB FX rates |
| `ledger.ts` | Exact integer accounting (BigInt) |
| `trading.ts` | Order engine: market, limit, queued orders, fills, corporate actions |
| `service.ts` | Seasons, portfolios, leaderboards, notifications, scheduled jobs, socket fan-out |
| `routes.ts` | REST API under `/api/rt`; the price socket is `/rt/ws` |

## Providers

No free plan gives real-time consolidated data for every exchange, and no free or personal plan
allows showing prices to the public. Check the licence before opening this to players.

| Provider | Coverage | Real time | Notes |
|---|---|---|---|
| Alpaca (free) | US stocks and ETFs | IEX venue only (a few percent of volume) | 200 req/min, 30 streamed symbols, news, calendar, corporate actions, movers |
| Alpaca Algo Trader Plus ($99/mo) | US | All venues (SIP) | Unlimited stream symbols |
| Twelve Data Basic (free) | US | US | 8 credits/min, 800/day; no bid/ask |
| Twelve Data Grow / Pro | + LSE, XETRA, Euronext, TSX / + HKEX, SSE, ASX | EU real time from Pro | Set `TWELVEDATA_EXCHANGES` and `TWELVEDATA_REALTIME` to match the plan |
| Tradegate (free, no key) | About 190 European blue chips (DAX, MDAX, SDAX, TecDAX, Euro Stoxx 50) in euro | Yes, bid/ask from Tradegate Berlin | Unofficial public endpoint with no published terms; no candles. Exchange `TG`, 07:30 to 22:00 Berlin |

Recommended: `REALTIME_PROVIDERS=alpaca,twelvedata,tradegate`. Alpaca prices US instruments; Twelve Data prices
the other exchanges and indices, and takes over US if Alpaca fails. An instrument no provider covers
shows "no price" and cannot be traded. The server never invents a price.

Every quote carries its source timestamp and a quality: `realtime`, `delayed` (with minutes), `eod` or
`dev`. The screen adds `stale` (older than `REALTIME_MAX_QUOTE_AGE_SECONDS` past its delay) and
`closed` (last price while the exchange is shut).

## Fill policy

- Server prices every order from its cache; the client sends only instrument, side, type, quantity, limit.
- Market orders: regular session only, buy at the ask, sell at the bid. With no usable side or a spread over
  `REALTIME_MAX_SPREAD_BPS`, the last trade plus `REALTIME_SLIPPAGE_BPS` against the player.
- Stale, missing or (unless `REALTIME_DELAYED_FILLS=true`) delayed quotes are refused.
- Limit orders reserve cash (buys) or shares (sells) and fill when a newer quote crosses the limit,
  including pre-market and after-hours when `REALTIME_EXTENDED_HOURS=true`. With `REALTIME_PARTIAL_FILLS`,
  a fill is capped at the quoted size.
- Closed market: limit orders can be queued for the next session after an explicit confirmation.
- Each fill runs in one transaction holding the account row lock. `clientOrderId` is unique per account,
  so a double click, a retry or a second tab returns the first result.
- Money is integer euro cents, quantity is micro-shares, price is 1/10,000 of the currency. Buys round up,
  sells round down. Foreign prices convert at the latest ECB rate; LSE pence are handled.

## Corporate actions

A daily job pulls splits, cash dividends and symbol changes (Alpaca) for held instruments. Splits rescale
quantity and open orders at unchanged cost; dividends are paid into cash on the ex-date; symbol changes
rename the instrument. Delistings mark the instrument and block trading; the position stays at its last
price. Each action applies once (`applied_at`).

## Calendars

Hardcoded from exchange pages for 2026 and 2027 (sources in the research notes): NYSE, TSX, LSE, TSE,
ASX verified; HKEX 2026 verified. Xetra and Euronext could not be loaded from the exchanges' own sites
and are flagged "not yet checked" in the UI; SSE and HKEX 2027 are not published yet. A provider calendar
(Alpaca for US) overrides the hardcoded one day by day. Past the published years the UI says holidays are unknown.

## Seasons

The open season always runs. Weekly and monthly seasons are created ahead of time; registration closes
`join_until` after the start so late joiners cannot pick a known outcome. At `ends_at` the standings freeze
into `rt_season_results` and players are notified.

## Testing outside market hours

- Automated: `npm test`. Pure tests (calendar, ledger, fill policy) always run; `test/realtime.db.test.ts`
  needs `TEST_DATABASE_URL` and uses injected quotes and a fake clock.
- Manual: `REALTIME_PROVIDERS=dev REALTIME_CLOCK=2026-11-24T15:10:00Z NODE_ENV=development npm run dev`.
  The clock starts at that instant and runs forward. Both are refused when `NODE_ENV=production`, and every
  screen shows a red "development data" bar while the dev feed is on.
