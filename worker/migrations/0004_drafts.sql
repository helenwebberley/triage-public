-- Adds Reply and Forward drafts (docs/DECISIONS.md 16). Idempotent.
--   npx wrangler d1 execute triage --remote --file migrations/0004_drafts.sql
CREATE TABLE IF NOT EXISTS drafts (
  user_id      INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  msg_id       TEXT NOT NULL,
  stage        TEXT NOT NULL,
  to_addr      TEXT,
  body         TEXT,
  created_ms   INTEGER NOT NULL
);
