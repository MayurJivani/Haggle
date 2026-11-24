-- Optional passwords: a player can claim their nickname and log in from another device.
ALTER TABLE users ADD COLUMN password_hash text;

-- Extra signed-in devices. The token made at join stays in users.token_hash.
CREATE TABLE user_sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);
