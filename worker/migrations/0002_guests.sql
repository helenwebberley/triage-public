-- One-off: turns the single-owner database of 2026-10-23 into the invite-only,
-- many-person one (docs/DECISIONS.md 14). Run once, straight before deploying the
-- code that needs it:
--   npx wrangler d1 execute triage --remote --file migrations/0002_guests.sql
-- Not idempotent (ALTER TABLE ADD COLUMN fails the second time). schema.sql is
-- the shape for a fresh database.

-- Hold the cron off for 10 minutes so the old code never meets the new tables.
UPDATE settings SET value = CAST((CAST(strftime('%s', 'now') AS INTEGER) + 600) * 1000 AS TEXT) WHERE key = 'lock_until';

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          TEXT NOT NULL UNIQUE,
  label            TEXT NOT NULL,
  is_owner         INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL DEFAULT 'watch',
  last_digest_slot TEXT,
  created_ms       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  used_ms      INTEGER,
  user_id      INTEGER
);

-- Helen becomes user 1, carrying her paired chat, mode and digest slot.
INSERT INTO users (id, chat_id, label, is_owner, mode, last_digest_slot, created_ms)
SELECT 1, value, 'Helen', 1,
       COALESCE((SELECT value FROM settings WHERE key = 'mode'), 'watch'),
       (SELECT value FROM settings WHERE key = 'last_digest_slot'),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM settings WHERE key = 'owner_chat_id';
DELETE FROM settings WHERE key IN ('owner_chat_id', 'mode', 'last_digest_slot', 'webhook_url');

ALTER TABLE accounts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oauth_states ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

-- senders was UNIQUE on the address; now it is per person, on a keyed hash. The
-- Worker fills addr_key and seals Helen's 280 rows on its first run.
CREATE TABLE senders_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  addr_key     TEXT,
  addr         TEXT NOT NULL,
  name         TEXT,
  account_id   TEXT,
  rule         TEXT,
  unsub        TEXT,
  unsub_post   TEXT,
  asked_ms     INTEGER,
  updated_ms   INTEGER,
  UNIQUE (user_id, addr_key)
);
INSERT INTO senders_new (id, user_id, addr_key, addr, name, account_id, rule, unsub, unsub_post, asked_ms, updated_ms)
SELECT id, 1, NULL, addr, name, account_id, rule, unsub, unsub_post, asked_ms, updated_ms FROM senders;
DROP TABLE senders;
ALTER TABLE senders_new RENAME TO senders;
