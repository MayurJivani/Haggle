-- Haggle RealTime: paper trading on real market data. Nothing here touches the simulated game's tables
-- except users. Units: account money is integer euro cents; quantities are micro-shares (1 share =
-- 1,000,000); instrument prices are integers in 1/10,000 of the instrument's currency.

CREATE TABLE rt_instruments (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  -- Listing venue (ISO 10383 MIC), and the calendar it trades on (calendar.ts).
  mic             text NOT NULL,
  exchange        text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('stock', 'etf', 'index', 'adr', 'reit', 'fund')),
  currency        text NOT NULL,
  country         text,
  sector          text,
  industry        text,
  market_cap_usd  bigint,
  logo_url        text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'halted', 'delisted')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mic, symbol)
);
CREATE INDEX rt_instruments_symbol ON rt_instruments (lower(symbol) text_pattern_ops);
CREATE INDEX rt_instruments_browse ON rt_instruments (exchange, sector, market_cap_usd DESC NULLS LAST);

-- The last quote seen per instrument, written in batches so a restart can show "last available price".
CREATE TABLE rt_quotes (
  instrument_id  bigint PRIMARY KEY REFERENCES rt_instruments(id) ON DELETE CASCADE,
  quote          jsonb NOT NULL,
  at             timestamptz NOT NULL
);

-- ECB reference rates: units of the currency per euro.
CREATE TABLE rt_fx (
  currency  text PRIMARY KEY,
  per_eur   numeric NOT NULL CHECK (per_eur > 0),
  as_of     date NOT NULL
);

-- Provider calendar days that override the built-in exchange calendar (holidays, early closes).
CREATE TABLE rt_calendar (
  exchange     text NOT NULL,
  day          date NOT NULL,
  open_local   text,
  close_local  text,
  source       text NOT NULL,
  PRIMARY KEY (exchange, day)
);

CREATE TABLE rt_seasons (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('open', 'weekly', 'monthly', 'event')),
  starting_cash_cents  bigint NOT NULL CHECK (starting_cash_cents > 0),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz,
  -- Registration closes here; null = any time (the open season).
  join_until           timestamptz,
  rules                text NOT NULL,
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'finished')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE rt_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id            uuid NOT NULL REFERENCES rt_seasons(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cash_cents           bigint NOT NULL CHECK (cash_cents >= 0),
  -- Cash held back for open buy orders; available = cash - reserved.
  reserved_cents       bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0 AND reserved_cents <= cash_cents),
  starting_cash_cents  bigint NOT NULL,
  joined_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, user_id)
);

CREATE TABLE rt_positions (
  account_id     uuid NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  instrument_id  bigint NOT NULL REFERENCES rt_instruments(id),
  qty            bigint NOT NULL CHECK (qty >= 0),
  -- Shares promised to open sell orders.
  reserved_qty   bigint NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= qty),
  -- Euro cost of the shares still held (FX at each buy included); average cost = cost / qty.
  cost_cents     bigint NOT NULL CHECK (cost_cents >= 0),
  realized_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, instrument_id)
);

CREATE TABLE rt_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  -- The duplicate guard: one client order id is one order, however often it is sent.
  client_order_id  uuid NOT NULL,
  instrument_id    bigint NOT NULL REFERENCES rt_instruments(id),
  side             text NOT NULL CHECK (side IN ('buy', 'sell')),
  type             text NOT NULL CHECK (type IN ('market', 'limit')),
  qty              bigint NOT NULL CHECK (qty > 0),
  filled_qty       bigint NOT NULL DEFAULT 0 CHECK (filled_qty >= 0 AND filled_qty <= qty),
  limit_price      bigint CHECK (limit_price > 0),
  reserved_cents   bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  -- Placed while the market was closed, with the player's say-so: it fills in the next eligible session.
  queued           boolean NOT NULL DEFAULT false,
  status           text NOT NULL CHECK (status IN ('open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_order_id),
  CHECK (type = 'market' OR limit_price IS NOT NULL)
);
CREATE INDEX rt_orders_working ON rt_orders (instrument_id) WHERE status IN ('open', 'partially_filled');
CREATE INDEX rt_orders_account ON rt_orders (account_id, created_at DESC);

CREATE TABLE rt_executions (
  id              bigserial PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES rt_orders(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  instrument_id   bigint NOT NULL REFERENCES rt_instruments(id),
  side            text NOT NULL CHECK (side IN ('buy', 'sell')),
  qty             bigint NOT NULL CHECK (qty > 0),
  price           bigint NOT NULL CHECK (price > 0),
  currency        text NOT NULL,
  fx_per_eur      numeric NOT NULL CHECK (fx_per_eur > 0),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  realized_cents  bigint NOT NULL DEFAULT 0,
  -- The quote the fill was priced from: its time, data quality and which side of the book.
  quote_at        timestamptz NOT NULL,
  quality         text NOT NULL,
  basis           text NOT NULL,
  executed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rt_executions_account ON rt_executions (account_id, executed_at DESC);
CREATE INDEX rt_executions_recent ON rt_executions (executed_at DESC);

CREATE TABLE rt_ledger (
  id                   bigserial PRIMARY KEY,
  account_id           uuid NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('grant', 'buy', 'sell', 'dividend', 'cash_in_lieu')),
  execution_id         bigint REFERENCES rt_executions(id),
  amount_cents         bigint NOT NULL,
  balance_after_cents  bigint NOT NULL CHECK (balance_after_cents >= 0),
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rt_ledger_account ON rt_ledger (account_id, id DESC);

CREATE TABLE rt_watchlist (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id  bigint NOT NULL REFERENCES rt_instruments(id) ON DELETE CASCADE,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instrument_id)
);

-- Portfolio value over time: every few minutes while any market is open.
CREATE TABLE rt_snapshots (
  account_id   uuid NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,
  value_cents  bigint NOT NULL,
  PRIMARY KEY (account_id, at)
);

CREATE TABLE rt_season_results (
  season_id          uuid NOT NULL REFERENCES rt_seasons(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  rank               integer NOT NULL,
  final_value_cents  bigint NOT NULL,
  return_bps         integer NOT NULL,
  best_pick          jsonb,
  PRIMARY KEY (season_id, account_id),
  UNIQUE (season_id, rank)
);

CREATE TABLE rt_profiles (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public   boolean NOT NULL DEFAULT false,
  -- Notification kinds the player switched off.
  muted    text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE rt_follows (
  follower_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE TABLE rt_notifications (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  text        text NOT NULL,
  -- One alert per thing per day (a watchlist move, a market open): the unique key says what.
  dedupe      text,
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe)
);
CREATE INDEX rt_notifications_user ON rt_notifications (user_id, id DESC);

CREATE TABLE rt_corporate_actions (
  id             bigserial PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES rt_instruments(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('split', 'dividend', 'symbol_change', 'delisting')),
  ex_date        date NOT NULL,
  -- Split: ratio_to new shares for every ratio_from old (a 4-for-1 split is from 1, to 4).
  ratio_from     integer CHECK (ratio_from > 0),
  ratio_to       integer CHECK (ratio_to > 0),
  -- Dividend per share, 1/10,000 of the instrument's currency.
  cash_amount    bigint CHECK (cash_amount > 0),
  new_symbol     text,
  source         text NOT NULL,
  applied_at     timestamptz,
  UNIQUE (instrument_id, kind, ex_date)
);
