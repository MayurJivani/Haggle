-- News belongs to the market, not to whichever room rang a bell: planned once per epoch, for everyone.
ALTER TABLE market_events ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE market_events ADD COLUMN engine_version text,
  ADD COLUMN source text;

-- Old ticks, folded into minute bars by a background job. Recent ticks stay exact; old games can be
-- replayed tick for tick from the epoch checkpoints, which are kept for good.
CREATE TABLE market_prices_1m (
  ticker    text NOT NULL REFERENCES assets(ticker),
  bucket    timestamptz NOT NULL,
  o         integer NOT NULL,
  h         integer NOT NULL,
  l         integer NOT NULL,
  c         integer NOT NULL,
  first_seq bigint NOT NULL,
  last_seq  bigint NOT NULL,
  PRIMARY KEY (ticker, bucket)
);
