-- One persistent market shared by every competition, simulated financials, and news stored before it
-- is published. Player accounts stay per competition; the market does not reset between them.

ALTER TABLE assets
  ADD COLUMN exchange   text NOT NULL DEFAULT '',
  ADD COLUMN industry   text NOT NULL DEFAULT '',
  ADD COLUMN shares_m   double precision;

-- Every competition records the purse it was played with. Older ones get the grant their players
-- actually received, so their results never change.
UPDATE sessions s SET config = s.config || jsonb_build_object('startingCash', coalesce(
  (SELECT l.amount_cents FROM ledger l JOIN participants p ON p.id = l.participant_id
   WHERE p.session_id = s.id AND l.kind = 'grant' ORDER BY l.id LIMIT 1),
  1000000))
WHERE NOT s.config ? 'startingCash';

ALTER TABLE sessions
  -- The market sequence number at the opening bell; null until the competition opens.
  ADD COLUMN start_seq       bigint,
  ADD COLUMN opening_prices  jsonb;

-- The authoritative market state, written every few ticks in the same transaction as the prices, news
-- status and reports it covers. The latest row is where a restart resumes. seq is the market's own
-- tick counter and never resets.
CREATE TABLE market_checkpoints (
  seq         bigint PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  state       jsonb NOT NULL
);

-- Price history across every competition and restart. `at` is the tick's scheduled time, not the
-- time it was written, so a replayed tick lands on exactly the same point.
CREATE TABLE market_prices (
  ticker       text NOT NULL REFERENCES assets(ticker),
  seq          bigint NOT NULL,
  at           timestamptz NOT NULL,
  session_id   uuid REFERENCES sessions(id) ON DELETE SET NULL,
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  PRIMARY KEY (ticker, seq)
);
CREATE INDEX market_prices_ticker_at ON market_prices (ticker, at);

-- News: scheduled when the bell rings, published when it lands. Never sent to a client before then.
ALTER TABLE market_events
  ADD COLUMN category      text NOT NULL DEFAULT 'company' CHECK (category IN ('macro', 'sector', 'company')),
  ADD COLUMN related       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN figures       jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN jump          double precision NOT NULL DEFAULT 1,
  ADD COLUMN persistence   double precision NOT NULL DEFAULT 1,
  ADD COLUMN report        jsonb,
  -- The market tick it lands on, and its lifecycle. 'cancelled' = the competition closed first.
  ADD COLUMN market_seq    bigint,
  ADD COLUMN status        text NOT NULL DEFAULT 'published' CHECK (status IN ('scheduled', 'published', 'cancelled')),
  ADD COLUMN published_at  timestamptz;
ALTER TABLE market_events ALTER COLUMN status SET DEFAULT 'scheduled';
UPDATE market_events e SET published_at = s.opens_at FROM sessions s WHERE s.id = e.session_id;
CREATE INDEX market_events_live ON market_events (market_seq) WHERE status <> 'cancelled';
CREATE INDEX market_events_published ON market_events (published_at DESC) WHERE status = 'published';

-- Simulated quarterly results. Annual figures are sums of a fiscal year's quarters.
CREATE TABLE financial_reports (
  ticker          text NOT NULL REFERENCES assets(ticker),
  fiscal_year     integer NOT NULL,
  fiscal_quarter  smallint NOT NULL CHECK (fiscal_quarter BETWEEN 1 AND 4),
  period_end      date NOT NULL,
  reported_at     timestamptz NOT NULL,
  revenue_m       double precision NOT NULL,
  net_income_m    double precision NOT NULL,
  eps             double precision NOT NULL,
  eps_estimate    double precision,
  source          text NOT NULL CHECK (source IN ('simulated', 'reported')),
  event_id        bigint REFERENCES market_events(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, fiscal_year, fiscal_quarter)
);

-- The exact move, not just the rounded basis points: a restart rebuilds the identical tape from it.
ALTER TABLE market_event_effects ADD COLUMN pct double precision;
