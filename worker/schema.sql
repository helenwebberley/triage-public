-- triage: D1 schema. Apply with:
--   npx wrangler d1 execute triage --remote --file schema.sql
-- Every statement is idempotent, so re-running it is safe.

-- One row per person who uses triage. Helen is the owner (is_owner = 1); everyone
-- else came in on one of her invites. label is her name for them, from the invite.
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          TEXT NOT NULL UNIQUE,   -- their private Telegram chat with the bot
  label            TEXT NOT NULL,
  is_owner         INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL DEFAULT 'watch',
  last_digest_slot TEXT,
  created_ms       INTEGER NOT NULL
);

-- Single-use invite links that Helen makes with /invite. Expire after 7 days.
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  used_ms      INTEGER,
  user_id      INTEGER
);

-- One row per connected inbox. enc_token is the Google refresh token, sealed with
-- AES-GCM under the TOKEN_KEY Worker secret. iCloud rows hold no token: the
-- app-specific password is the ICLOUD_APP_PASSWORD Worker secret (Helen only).
-- label and email are sealed per person (src/seal.js) for every row made since
-- sealing began; Helen's four older rows are plain.
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,          -- the owner's: a slug, e.g. work-gmail. Guests': u<user id>-<random>
  user_id      INTEGER NOT NULL DEFAULT 1,
  kind         TEXT NOT NULL,             -- gmail | icloud
  label        TEXT NOT NULL,             -- what they call it, e.g. Work Gmail
  email        TEXT,
  enc_token    TEXT,
  cursor_ms    INTEGER NOT NULL DEFAULT 0, -- only mail received after this is looked at
  last_ok_at   INTEGER,
  last_error   TEXT
);

-- What has been seen and what it was judged to be. Pruned after 30 days.
-- from_addr, from_name, subject, summary and why are sealed per person.
CREATE TABLE IF NOT EXISTS messages (
  account_id   TEXT NOT NULL,
  msg_id       TEXT NOT NULL,             -- Gmail message id, or iCloud UID
  thread_id    TEXT,
  sender_id    INTEGER,
  from_addr    TEXT,
  from_name    TEXT,
  subject      TEXT,
  received_ms  INTEGER,
  category     TEXT,                      -- needs_you | fyi | newsletter | junk
  summary      TEXT,
  why          TEXT,
  notified     INTEGER NOT NULL DEFAULT 0,
  in_digest    INTEGER NOT NULL DEFAULT 0,
  created_ms   INTEGER NOT NULL,
  PRIMARY KEY (account_id, msg_id)
);
CREATE INDEX IF NOT EXISTS messages_digest ON messages (in_digest, category);

-- One row per sending address, per person. rule is their standing instruction.
-- addr, name, unsub and unsub_post are sealed; addr_key is a keyed hash of the
-- address so a sender can be found without the address being readable.
CREATE TABLE IF NOT EXISTS senders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  addr_key     TEXT,                      -- null only on rows awaiting sealing
  addr         TEXT NOT NULL,
  name         TEXT,
  account_id   TEXT,                      -- the inbox their latest mail arrived in
  rule         TEXT,                      -- null | vip | keep | mute | unsubscribed
  unsub        TEXT,                      -- raw List-Unsubscribe header, latest seen
  unsub_post   TEXT,                      -- raw List-Unsubscribe-Post header
  asked_ms     INTEGER,                   -- when the unsubscribe question was put to Helen
  updated_ms   INTEGER,
  UNIQUE (user_id, addr_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        TEXT
);

-- Single-use, short-lived states for the Google connect flow.
CREATE TABLE IF NOT EXISTS oauth_states (
  state        TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  user_id      INTEGER NOT NULL DEFAULT 1,
  label        TEXT NOT NULL,             -- sealed
  created_ms   INTEGER NOT NULL
);

-- People who tapped Ask to join on the public page and are waiting for Helen's
-- yes or no. name is their Telegram display name, which Helen sees to decide.
-- A declined chat cannot ask again for 30 days; rows are deleted after that.
CREATE TABLE IF NOT EXISTS join_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  username     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | declined
  created_ms   INTEGER NOT NULL
);

-- A Reply or Forward someone has started from an alert, one per person. to_addr
-- and body are sealed. stage: text (waiting for them to type) | confirm (shown,
-- waiting for Send). Lapses after 30 minutes.
CREATE TABLE IF NOT EXISTS drafts (
  user_id      INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,             -- r (reply) | f (forward)
  account_id   TEXT NOT NULL,
  msg_id       TEXT NOT NULL,
  stage        TEXT NOT NULL,
  to_addr      TEXT,
  body         TEXT,
  created_ms   INTEGER NOT NULL
);

-- Forwarding rules (docs/DECISIONS.md 17). kind: sender | domain | topic.
-- match and to_addr are sealed; match_key is the keyed hash of the sender
-- address or of "@domain", so a rule is found without either being readable.
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
