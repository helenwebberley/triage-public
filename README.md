# Triage

Triage reads your email as it arrives, has Claude sort each one, and messages you
on Telegram only about what genuinely needs you. Everything else waits for a
digest at 8am and 5pm, and newsletters go with one tap.

This is the code that runs at https://triage.hw-tools.io, published
automatically every time that site is deployed, so it always matches what is
running. Each commit here is named after the private commit it was made from.
The site's own explanation, written for curious people, is
https://triage.hw-tools.io/how.

## What is different from the running copy

Only the owner's personal settings:

- `worker/src/owner.js` is the example from `owner.example.js`. The real one
  describes the owner (work, family, what matters) to the classifier.
- `worker/wrangler.toml` has placeholders where the real one has account ids,
  addresses and the domain.

Everything else, including the encryption, the schema and the tests, is
exactly what runs.

## The shape

- `worker/src/index.js`: the Cloudflare Worker. A cron every 5 minutes reads
  each person's new mail; a webhook takes their Telegram messages and taps.
- `worker/src/classify.js`: one Claude call per email, constrained to a JSON
  schema (category, summary, reason, a few flags). The model never chooses an
  action; code does.
- `worker/src/seal.js`: per-person encryption. Keys are derived with HKDF from
  one Worker secret; data is sealed with AES-GCM; sender lookups use HMAC.
- `worker/src/gmail.js`, `icloud.js`, `imap.js`: reading mail.
- `worker/src/forward.js`, `unsubscribe.js`, `telegram.js`: sending,
  unsubscribing, talking.
- `worker/schema.sql`: the D1 database. `worker/migrations/`: changes to a live one.
- `web/`: the public page, served as Worker static assets.

## Run your own

You need a Cloudflare account, a Telegram bot (from @BotFather), a Google Cloud
OAuth client with the Gmail API enabled (scope `gmail.modify`, redirect
`https://<your host>/oauth/callback`) and an Anthropic API key.

```bash
cd worker
npm install
npx wrangler d1 create triage            # put the id in wrangler.toml
npx wrangler d1 execute triage --remote --file schema.sql
# edit wrangler.toml and src/owner.js, then set each secret without echoing it:
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put TOKEN_KEY
openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 16 | tr -d '\n' | npx wrangler secret put PAIR_CODE   # keep it: you pair with it once
npx wrangler deploy
```

Within five minutes the first cron registers the webhook. Then open
`https://t.me/<your bot>?start=<PAIR_CODE>` and press Start: you are the owner.
`/connect Gmail` connects an inbox; `/help` lists the rest.

`npm test` runs the unit tests.

## Licence

MIT. See `LICENSE`.
