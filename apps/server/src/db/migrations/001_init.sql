-- Money is integer euro cents everywhere. Quantities are whole shares.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname    text NOT NULL CHECK (char_length(nickname) BETWEEN 2 AND 20),
  -- SHA-256 of the cookie token; a leaked table never hands over a live session.
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_nickname_lower ON users (lower(nickname));

CREATE TABLE assets (
  ticker            text PRIMARY KEY,
  name              text NOT NULL,
  sector            text NOT NULL,
  description       text NOT NULL,
  base_price_cents  integer NOT NULL CHECK (base_price_cents > 0),
  volatility        double precision NOT NULL CHECK (volatility > 0),
  beta              double precision NOT NULL,
  sensitivities     jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed            bigint NOT NULL,
  status          text NOT NULL CHECK (status IN ('lobby', 'trading', 'finished')),
  config          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  opens_at        timestamptz NOT NULL,
  closes_at       timestamptz NOT NULL,
  finished_at     timestamptz,
  closing_prices  jsonb,
  CHECK (closes_at > opens_at)
);
-- Only one session can be live at a time.
CREATE UNIQUE INDEX sessions_one_live ON sessions ((true)) WHERE status <> 'finished';

CREATE TABLE participants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cash_cents  bigint NOT NULL CHECK (cash_cents >= 0),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id)
);

CREATE TABLE positions (
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  ticker          text NOT NULL REFERENCES assets(ticker),
  quantity        integer NOT NULL CHECK (quantity >= 0),
  -- Total cost of the shares still held, so average cost = cost_cents / quantity.
  cost_cents      bigint NOT NULL CHECK (cost_cents >= 0),
  realized_cents  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (participant_id, ticker)
);

-- Market orders fill immediately, so an executed order and its trade are one row.
CREATE TABLE trades (
  id               bigserial PRIMARY KEY,
  participant_id   uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  client_order_id  uuid NOT NULL,
  ticker           text NOT NULL REFERENCES assets(ticker),
  side             text NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity         integer NOT NULL CHECK (quantity > 0),
  price_cents      integer NOT NULL CHECK (price_cents > 0),
  total_cents      bigint NOT NULL CHECK (total_cents > 0),
  realized_cents   bigint NOT NULL DEFAULT 0,
  tick             integer NOT NULL,
  executed_at      timestamptz NOT NULL DEFAULT now(),
  -- The duplicate-execution guard: one client order id executes at most once.
  UNIQUE (participant_id, client_order_id)
);

CREATE TABLE ledger (
  id                   bigserial PRIMARY KEY,
  participant_id       uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('grant', 'buy', 'sell')),
  trade_id             bigint REFERENCES trades(id),
  amount_cents         bigint NOT NULL,
  balance_after_cents  bigint NOT NULL CHECK (balance_after_cents >= 0),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_participant ON ledger (participant_id, id);

CREATE TABLE price_history (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tick         integer NOT NULL,
  ticker       text NOT NULL REFERENCES assets(ticker),
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  PRIMARY KEY (session_id, ticker, tick)
);

CREATE TABLE market_events (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  template     text NOT NULL,
  headline     text NOT NULL,
  description  text NOT NULL,
  severity     smallint NOT NULL CHECK (severity BETWEEN 1 AND 3),
  scope        text NOT NULL,
  target       text,
  tick         integer NOT NULL,
  duration     integer NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE market_event_effects (
  event_id    bigint NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  ticker      text NOT NULL REFERENCES assets(ticker),
  impact_bps  integer NOT NULL,
  PRIMARY KEY (event_id, ticker)
);

CREATE TABLE leaderboard_snapshots (
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tick        integer NOT NULL,
  ranking     jsonb NOT NULL,
  PRIMARY KEY (session_id, tick)
);

CREATE TABLE results (
  session_id        uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id    uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  rank              integer NOT NULL,
  final_value_cents bigint NOT NULL,
  return_bps        integer NOT NULL,
  stats             jsonb NOT NULL,
  PRIMARY KEY (session_id, participant_id),
  UNIQUE (session_id, rank)
);
