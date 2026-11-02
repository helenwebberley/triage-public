-- Adds forwarding rules (docs/DECISIONS.md 17). Idempotent.
--   npx wrangler d1 execute triage --remote --file migrations/0005_rules.sql
CREATE TABLE IF NOT EXISTS rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  match_key    TEXT,
  match        TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  last_used_ms INTEGER,
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_user ON rules (user_id);
