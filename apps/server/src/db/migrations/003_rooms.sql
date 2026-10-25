-- Custom rooms. A room is a competition with a name, a host and its own rules; the house competition
-- that loops by itself is the one with no code. Every room trades the same persistent market, while
-- cash, positions, trades, leaderboards and results stay per competition as before.

ALTER TABLE sessions
  ADD COLUMN code          text UNIQUE CHECK (code ~ '^[A-Z2-9]{8}$'),
  ADD COLUMN name          text CHECK (char_length(name) BETWEEN 1 AND 40),
  ADD COLUMN description   text CHECK (char_length(description) <= 200),
  ADD COLUMN host_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  -- The awards as published at the close, so a finished room's results can be served from here.
  ADD COLUMN awards        jsonb;

-- Many rooms may be live at once; only one house competition is.
DROP INDEX sessions_one_live;
CREATE UNIQUE INDEX sessions_one_live_house ON sessions ((true)) WHERE status <> 'finished' AND code IS NULL;
CREATE INDEX sessions_live ON sessions (created_at) WHERE status <> 'finished';
CREATE INDEX sessions_host ON sessions (host_user_id) WHERE status <> 'finished';
