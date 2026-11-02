-- Adds Ask to join (docs/DECISIONS.md 15). Idempotent.
--   npx wrangler d1 execute triage --remote --file migrations/0003_join_requests.sql
CREATE TABLE IF NOT EXISTS join_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  username     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_ms   INTEGER NOT NULL
);
