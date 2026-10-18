# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Brief-specified: React + TypeScript + Vite + Tailwind (web), Node + TypeScript with WebSockets (server), PostgreSQL, Docker Compose. Follows the FRC "app shape" (npm workspace, `apps/web` + `apps/server`). Charts: Lightweight Charts. Motion: Motion (motion.dev). Redis deliberately omitted while one Node process owns the session. Deployed to Jinx with a systemd unit and Caddy block (DEPLOY.md shape) at haggle.futile.studio.

## Users

Players at a hosted live event (meetup, classroom, office party). An organiser runs the session; players join from their own phones and laptops, often in the same room, and a shared big screen may show the opening bell, events and the final results. Most players are not traders: they need to understand prices, cash and rank at a glance within seconds of joining.

## Product Purpose

Haggle is a short, synchronised stock-market competition with virtual money only. Up to 500 players start with exactly €1,000, trade simulated prices for real company names, react to broadcast market events, and finish ranked by portfolio value. Success: a full session runs start to finish with no accounting error, everyone sees the same market at the same moment, and the room cares about the leaderboard.

## Positioning

A shared live event, not a solo trading simulator: one market, one clock, one event feed and one leaderboard for the whole room. Prices are server-authoritative and seeded, so every player trades the same tape and the final ranking is deterministic.

## Operating Context

- Session loop: lobby, opening bell, trading, closing countdown, results. The whole event runs in 10 to 15 minutes and every phase length is configurable.
- Sessions loop automatically; an organiser with the admin token can open the bell early.
- Players join with a nickname only. Identity lives in a cookie on that device; reconnecting on the same device restores the portfolio.
- Shareable per-player result card after the close.

## Capabilities and Constraints

- Virtual money only. No deposits, withdrawals, brokerage, leverage, shorting, options or margin.
- Market buy/sell only, integer share quantities, no fees.
- All prices and market data are simulated and must be labelled as such; real company names never imply live quotes.
- Trading does not move prices.
- Main winner: highest final portfolio value. Secondary awards: risk-adjusted return and best performance during major events.
- Undecided: account recovery across devices (not offered in v1).

## Brand Commitments

- Name: Haggle (renamed from Live Bazar on 2026-10-19).
- Brief-pinned visual direction: dark trading-terminal aesthetic, high-contrast type, green/red market indicators, animated charts and tickers, a striking opening bell and results ceremony.
- FRC writing rules: no em dashes in UI copy or docs.

## Evidence on Hand

None. No real users, testimonials or partners exist; do not invent any. Company list and events are authored seed data, labelled simulated.

## Product Principles

1. The server is the only truth: prices, clock, cash and rank are never computed on trust from the client.
2. Readable in seconds: a first-time player should know their cash, value and rank without being told.
3. Same moment for everyone: events and the bell land on every screen together.
4. Money is exact: integer cents end to end, every trade in a durable ledger.

## Accessibility & Inclusion

Green/red is never the only signal: direction also carries a sign and an arrow. Keyboard-operable order entry. Respect prefers-reduced-motion for ceremonies and tickers.
