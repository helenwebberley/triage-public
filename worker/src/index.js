// triage: watches inboxes, tells their owner on Telegram about what needs them,
// and unsubscribes from what does not, when they say so.
//
// Helen is the owner. Anyone else uses it on her invite, in their own private
// chat with the bot, and everything about their mail is sealed under a key of
// their own (docs/DECISIONS.md 14).
//
//   scheduled()  every 5 minutes: for each person, read new mail, sort it, ping
//                or queue it, and at the digest hours send their digest.
//   fetch()      /telegram (bot webhook), /oauth/callback (Google connect),
//                /health.

import * as gmail from "./gmail.js";
import * as icloud from "./icloud.js";
import { classify } from "./classify.js";
import { unsubscribe } from "./unsubscribe.js";
import { buildForward, buildReply, pickSender } from "./forward.js";
import * as tg from "./telegram.js";
import { seal, randomToken, userKeys, sealWith, openWith, openRow, addrKey } from "./seal.js";
import { esc, slug, isCopyOf, parseFrom } from "./mail.js";

const now = () => Date.now();
const DAY = 24 * 3600 * 1000;
const INVITE_DAYS = 7;
const DRAFT_MINUTES = 30; // a Reply or Forward left unfinished lapses after this
const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[a-z]{2,}$/i;
const MAX_PENDING_REQUESTS = 20; // so a flood of strangers cannot bury Helen's chat

// What is sealed in each table (src/seal.js).
const ACCOUNT_SEALED = ["label", "email"];
const SENDER_SEALED = ["addr", "name", "unsub", "unsub_post"];
const MESSAGE_SEALED = ["from_addr", "from_name", "subject", "summary", "why"];

// ---------- small D1 helpers ----------

const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

async function getSetting(env, key) {
  return (await one(env, "SELECT value FROM settings WHERE key = ?", key))?.value ?? null;
}
function setSetting(env, key, value) {
  return run(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
}

// ---------- people ----------

// u = { user, keys, chatId, owner }: everything a handler needs about one person.
async function person(env, user) {
  return { user, keys: await userKeys(env, user.id), chatId: user.chat_id, owner: !!user.is_owner };
}
const S = (u, v) => sealWith(u.keys, v);

async function accountsOf(env, u) {
  const rows = await all(env, "SELECT * FROM accounts WHERE user_id = ?", u.user.id);
  for (const r of rows) await openRow(u.keys, r, ACCOUNT_SEALED);
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}
async function accountOf(env, u, id) {
  return openRow(u.keys, await one(env, "SELECT * FROM accounts WHERE id = ? AND user_id = ?", id, u.user.id), ACCOUNT_SEALED);
}

// Deletes everything held for one inbox, and hands the Google access back.
async function dropAccount(env, account) {
  if (account.kind === "gmail") await gmail.revoke(env, account);
  await run(env, "DELETE FROM messages WHERE account_id = ?", account.id);
  await run(env, "DELETE FROM accounts WHERE id = ?", account.id);
}

// Deletes a guest and everything held for them. Never the owner.
async function dropUser(env, user) {
  if (user.is_owner) throw new Error("the owner cannot be removed");
  for (const a of await all(env, "SELECT * FROM accounts WHERE user_id = ?", user.id)) await dropAccount(env, a);
  await run(env, "DELETE FROM senders WHERE user_id = ?", user.id);
  await run(env, "DELETE FROM drafts WHERE user_id = ?", user.id);
  await run(env, "DELETE FROM rules WHERE user_id = ?", user.id);
  await run(env, "DELETE FROM oauth_states WHERE user_id = ?", user.id);
  await run(env, "DELETE FROM users WHERE id = ?", user.id);
}

const ownerUser = (env) => one(env, "SELECT * FROM users WHERE is_owner = 1");

// ---------- senders ----------

async function upsertSender(env, u, msg) {
  const key = await addrKey(u.keys, msg.from.addr);
  await run(
    env,
    `INSERT INTO senders (user_id, addr_key, addr, name, account_id, unsub, unsub_post, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, addr_key) DO UPDATE SET
       addr = excluded.addr, name = excluded.name, account_id = excluded.account_id, updated_ms = excluded.updated_ms,
       unsub = COALESCE(NULLIF(excluded.unsub, ''), senders.unsub),
       unsub_post = COALESCE(NULLIF(excluded.unsub_post, ''), senders.unsub_post)`,
    u.user.id, key, await S(u, msg.from.addr), await S(u, msg.from.name), msg.accountId,
    await S(u, msg.listUnsub || ""), await S(u, msg.listUnsubPost || ""), now(),
  );
  return openRow(u.keys, await one(env, "SELECT * FROM senders WHERE user_id = ? AND addr_key = ?", u.user.id, key), SENDER_SEALED);
}

// Rows from before sealing (Helen's) get their lookup key and are sealed, a
// batch at a time. Polling waits until none are left, so no sender is doubled.
async function sealLegacySenders(env) {
  const rows = await all(env, "SELECT * FROM senders WHERE addr_key IS NULL LIMIT 500");
  if (!rows.length) return true;
  const keys = new Map();
  const stmts = [];
  for (const r of rows) {
    if (!keys.has(r.user_id)) keys.set(r.user_id, await userKeys(env, r.user_id));
    const k = keys.get(r.user_id);
    stmts.push(
      env.DB.prepare("UPDATE senders SET addr_key = ?, addr = ?, name = ?, unsub = ?, unsub_post = ? WHERE id = ?").bind(
        await addrKey(k, await openWith(k, r.addr)),
        await sealWith(k, await openWith(k, r.addr)),
        await sealWith(k, await openWith(k, r.name)),
        await sealWith(k, await openWith(k, r.unsub)),
        await sealWith(k, await openWith(k, r.unsub_post)),
        r.id,
      ),
    );
  }
  await env.DB.batch(stmts);
  return rows.length < 500;
}

// ---------- forwarding rules (docs/DECISIONS.md 17) ----------
//
// sender: one address. domain: everything from @domain. topic: a description
// the classifier checks each email against. match and to_addr are sealed;
// match_key is the keyed hash used to find sender and domain rules.

async function rulesOf(env, u) {
  const rows = await all(env, "SELECT * FROM rules WHERE user_id = ? ORDER BY id", u.user.id);
  for (const r of rows) await openRow(u.keys, r, ["match", "to_addr"]);
  return rows;
}

const domainOf = (addr) => String(addr || "").toLowerCase().split("@")[1] || "";

function describeRule(r) {
  if (r.kind === "sender") return `every email from ${r.match}`;
  if (r.kind === "domain") return `everything from @${r.match}`;
  return `emails about "${r.match}"`;
}

// Which rules this email triggers, one per destination. Never junk or anything
// that looks like phishing, never back to the address it came from.
async function matchRules(u, rules, msg, sender, verdict) {
  if (!rules.length || verdict.suspicious || verdict.category === "junk") return [];
  const domainKey = await addrKey(u.keys, "@" + domainOf(msg.from.addr));
  const topicHits = new Set(verdict.matches || []);
  const hits = rules.filter(
    (r) =>
      (r.kind === "sender" && r.match_key === sender.addr_key) ||
      (r.kind === "domain" && r.match_key === domainKey) ||
      (r.kind === "topic" && topicHits.has(`T${r.id}`)),
  );
  const seen = new Set([msg.from.addr.toLowerCase()]);
  return hits.filter((r) => !seen.has(r.to_addr) && seen.add(r.to_addr));
}

// Sent from the inbox it came to, or from the person's first connected Gmail
// when that inbox cannot send (iCloud). A quiet note says what went; a failure
// is loud, so nothing is lost silently.
async function forwardByRule(env, u, account, accounts, inbox, msg, rule) {
  try {
    const via = account.kind === "gmail" ? account : accounts.find((a) => a.kind === "gmail" && a.enc_token);
    if (!via) throw new Error("no connected Gmail inbox to send it from");
    const raw = await inbox.raw(msg.msgId);
    if (!raw) throw new Error("could not fetch the original");
    const fwd = await buildForward(raw, { to: rule.to_addr, received: msg.receivedMs });
    const out = via.id === account.id ? inbox : await gmail.open(env, via);
    await out.sendMime(fwd.mime);
    await run(env, "UPDATE rules SET used = used + 1, last_used_ms = ? WHERE id = ?", now(), rule.id);
    await tg.send(env, u.chatId, `↪️ Forwarded <b>${esc(msg.subject)}</b> to ${esc(rule.to_addr)} (your rule: ${esc(describeRule(rule))}).`, undefined, { quiet: true });
  } catch (e) {
    await tg.send(env, u.chatId, `⚠️ Your rule could not forward <b>${esc(msg.subject)}</b> to ${esc(rule.to_addr)} (${esc(String(e.message || e).slice(0, 200))}). Forward it yourself.`);
  }
}

async function openInbox(env, account) {
  return account.kind === "gmail" ? gmail.open(env, account) : icloud.open(env, account);
}

// ---------- polling ----------

async function pollAccount(env, u, account, accounts) {
  const max = Number(env.MAX_PER_RUN || 25);
  const inbox = await openInbox(env, account);
  const isSeen = async (id) => !!(await one(env, "SELECT 1 FROM messages WHERE account_id = ? AND msg_id = ?", account.id, id));

  let msgs;
  if (account.kind === "gmail") {
    const ids = [];
    for (const id of await inbox.listNew(account.cursor_ms, max)) if (!(await isSeen(id))) ids.push(id);
    msgs = [];
    for (const id of ids) msgs.push(await inbox.get(id));
  } else {
    msgs = await inbox.fetchNew(account.cursor_ms, max, isSeen);
  }
  msgs.sort((a, b) => a.receivedMs - b.receivedMs);

  const mine = accounts.map((a) => String(a.email || "").toLowerCase());
  const rules = await rulesOf(env, u);
  const topics = rules.filter((r) => r.kind === "topic").map((r) => ({ id: `T${r.id}`, text: r.match }));
  const actMode = u.user.mode === "act";
  let cursor = account.cursor_ms;
  const toArchive = [];
  for (const msg of msgs) {
    const sender = await upsertSender(env, u, msg);
    let verdict;
    if (sender.rule === "unsubscribed") verdict = { category: "newsletter", summary: msg.subject, why: "you unsubscribed from them" };
    else if (sender.rule === "mute") verdict = { category: "fyi", summary: msg.subject, why: "you muted them" };
    else verdict = await classify(env, msg, { owner: u.owner, topics }); // throws: stop here, retry next run
    if (sender.rule === "vip") verdict.category = "needs_you";
    // Travel forwarding and copies are the owner's settings alone.
    if (!u.owner || !env.TRAVEL_TO) verdict.travel = false;
    // A booking the model doubts is never binned unseen: Helen decides.
    const doubtfulBooking = u.owner && verdict.travel && (verdict.suspicious || verdict.category === "junk");
    if (doubtfulBooking) {
      verdict.category = "needs_you";
      verdict.why = `Looks like a booking, but may not be genuine. If it is real, forward it to ${env.TRAVEL_TO}.`;
    }
    // The owner may get copies of someone else's mail (COPIES_OF). They hear
    // about it only when it is a reminder or urgent; the rest stays out of
    // alerts and the digest. Bookings are still forwarded below.
    const copy = u.owner && isCopyOf(msg, env.COPIES_OF, mine);
    let hidden = false;
    if (copy && !doubtfulBooking) {
      const flag = verdict.reminder && !verdict.suspicious && verdict.category !== "junk";
      if (flag) {
        verdict.category = "needs_you";
        verdict.why = `${env.COPIES_LABEL || "A copy"}: ${verdict.why}`;
      } else {
        if (verdict.category === "needs_you") verdict.category = "fyi";
        hidden = true;
      }
    }

    await run(
      env,
      `INSERT OR IGNORE INTO messages (account_id, msg_id, thread_id, sender_id, from_addr, from_name, subject, received_ms, category, summary, why, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      account.id, msg.msgId, msg.threadId, sender.id, await S(u, msg.from.addr), await S(u, msg.from.name), await S(u, msg.subject), msg.receivedMs,
      verdict.category, await S(u, verdict.summary), await S(u, verdict.why), now(),
    );
    if (hidden) await run(env, "UPDATE messages SET in_digest = 1 WHERE account_id = ? AND msg_id = ?", account.id, msg.msgId);

    // Bookings go on to the travel desk (TRAVEL_TO) whatever the mode. The
    // desk's own mail never goes back to it. Owner only.
    if (u.owner && verdict.travel && !doubtfulBooking && !fromTravelDesk(env, msg)) {
      await forwardTravel(env, u, account, accounts, inbox, msg);
    }

    for (const rule of await matchRules(u, rules, msg, sender, verdict)) {
      await forwardByRule(env, u, account, accounts, inbox, msg, rule);
    }

    if (verdict.category === "needs_you") {
      await notify(env, u, account, msg, sender, verdict);
      await run(env, "UPDATE messages SET notified = 1 WHERE account_id = ? AND msg_id = ?", account.id, msg.msgId);
    }

    const archivable =
      verdict.category !== "needs_you" &&
      (sender.rule === "unsubscribed" || sender.rule === "mute" || verdict.category === "junk" ||
        (verdict.category === "newsletter" && sender.rule !== "keep"));
    if (actMode && archivable) toArchive.push(msg.msgId);

    cursor = Math.max(cursor, msg.receivedMs);
  }

  if (toArchive.length) await inbox.archive(account.kind === "gmail" ? toArchive : toArchive.map(Number));
  await run(env, "UPDATE accounts SET cursor_ms = ?, last_ok_at = ?, last_error = NULL WHERE id = ?", cursor, now(), account.id);
  return msgs.length;
}

// One-off repairs for Helen, set by hand in D1 when she says an email was
// wrongly binned (Gmail inboxes): settings.rescue = '[["account_id","msg_id"], ...]'.
// Each goes back in the inbox and on to the travel desk, then the setting is cleared.
async function rescue(env, u, accounts) {
  const list = JSON.parse((await getSetting(env, "rescue")) || "[]");
  if (!list.length) return;
  await setSetting(env, "rescue", "[]");
  for (const [accountId, msgId] of list) {
    const account = accounts.find((a) => a.id === accountId);
    if (account?.kind !== "gmail") continue; // Gmail only for now
    const inbox = await gmail.open(env, account);
    await inbox.unarchive([msgId]);
    await run(env, "UPDATE messages SET category = 'fyi' WHERE account_id = ? AND msg_id = ?", accountId, msgId);
    await forwardTravel(env, u, account, accounts, inbox, await inbox.get(msgId));
  }
}

const fromTravelDesk = (env, msg) =>
  String(msg.from.addr || "").toLowerCase().endsWith("@" + String(env.TRAVEL_TO || "").split("@")[1].toLowerCase());

// Success is silent: Helen does not want to hear about each forward.
// A failure here must not lose the email: it is already recorded as seen, so
// Helen is told to forward it herself rather than it being retried.
async function forwardTravel(env, u, account, accounts, inbox, msg) {
  const subject = `<b>${esc(msg.subject)}</b>`;
  try {
    const via = pickSender(env, account, accounts);
    if (!via) throw new Error("no connected inbox that the travel desk accepts mail from");
    const raw = await inbox.raw(msg.msgId);
    if (!raw) throw new Error("could not fetch the original");
    const fwd = await buildForward(raw, { to: env.TRAVEL_TO, received: msg.receivedMs });
    const out = via.id === account.id ? inbox : await gmail.open(env, via);
    await out.sendMime(fwd.mime);
  } catch (e) {
    const open = msg.link ? [[{ text: "Open", url: msg.link }]] : undefined;
    await tg.send(env, u.chatId, `⚠️ Could not send ${subject} to the travel desk (${esc(String(e.message || e).slice(0, 200))}). Forward it to ${esc(env.TRAVEL_TO)} yourself.`, open);
  }
}

async function notify(env, u, account, msg, sender, verdict) {
  const who = msg.from.name ? `${esc(msg.from.name)} &lt;${esc(msg.from.addr)}&gt;` : esc(msg.from.addr);
  const html = [
    `🔴 <b>${esc(msg.subject)}</b>`,
    `${who} · ${esc(account.label)}`,
    "",
    esc(verdict.summary),
    `<i>${esc(verdict.why)}</i>`,
  ].join("\n");
  const row = [];
  if (msg.link) row.push({ text: "Open", url: msg.link });
  row.push({ text: "✓ Done", callback_data: "d" }, { text: "Not important", callback_data: `n:${sender.id}` });
  const rows = [row];
  // Reply and Forward send mail, so only from inboxes that can (Gmail).
  const second = [];
  if (account.kind === "gmail") {
    second.push(
      { text: "↩️ Reply", callback_data: `r:${account.id}:${msg.msgId}` },
      { text: "↪️ Forward", callback_data: `f:${account.id}:${msg.msgId}` },
    );
  }
  second.push({ text: "⚙️ Rule", callback_data: `w:${account.id}:${msg.msgId}` });
  rows.push(second);
  await tg.send(env, u.chatId, html, rows);
}

// ---------- digest ----------

function londonClock(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { hour: Number(parts.hour), minute: Number(parts.minute), slot: `${parts.year}-${parts.month}-${parts.day}-${parts.hour}` };
}

async function maybeDigest(env, u) {
  const { hour, minute, slot } = londonClock();
  const hours = String(env.DIGEST_HOURS || "8,17").split(",").map(Number);
  if (!hours.includes(hour) || minute >= 10) return;
  if (u.user.last_digest_slot === slot) return;
  await run(env, "UPDATE users SET last_digest_slot = ? WHERE id = ?", slot, u.user.id);
  await sendDigest(env, u);
}

async function sendDigest(env, u) {
  const rows = await all(
    env,
    `SELECT m.*, a.label FROM messages m JOIN accounts a ON a.id = m.account_id
     WHERE a.user_id = ? AND m.in_digest = 0 AND m.category != 'needs_you' ORDER BY m.received_ms`,
    u.user.id,
  );
  const fyi = rows.filter((r) => r.category === "fyi");
  const news = rows.filter((r) => r.category === "newsletter");
  const junk = rows.filter((r) => r.category === "junk");

  const lines = [`📬 <b>Digest</b>: ${fyi.length} for information, ${news.length} newsletters, ${junk.length} junk`];
  if (fyi.length) {
    lines.push("");
    for (const r of fyi.slice(-20)) {
      await openRow(u.keys, r, [...MESSAGE_SEALED, "label"]);
      lines.push(`• <b>${esc(r.from_name || r.from_addr)}</b> (${esc(r.label)}): ${esc(r.summary)}`);
    }
    if (fyi.length > 20) lines.push(`…and ${fyi.length - 20} older ones.`);
  }
  if (!rows.length) lines.push("", "Nothing new since the last one.");
  await tg.send(env, u.chatId, lines.join("\n"));
  await run(
    env,
    "UPDATE messages SET in_digest = 1 WHERE in_digest = 0 AND category != 'needs_you' AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)",
    u.user.id,
  );

  // One question per newsletter sender they have never been asked about.
  const ask = await all(
    env,
    `SELECT s.*, COUNT(m.msg_id) AS n, MAX(m.subject) AS latest, a.label
     FROM senders s JOIN messages m ON m.sender_id = s.id AND m.category = 'newsletter'
     LEFT JOIN accounts a ON a.id = s.account_id
     WHERE s.user_id = ? AND s.rule IS NULL AND s.asked_ms IS NULL
     GROUP BY s.id ORDER BY n DESC LIMIT ?`,
    u.user.id,
    Number(env.ASKS_PER_DIGEST || 8),
  );
  for (const s of ask) {
    await openRow(u.keys, s, [...SENDER_SEALED, "latest", "label"]);
    const name = s.name ? `${esc(s.name)} &lt;${esc(s.addr)}&gt;` : esc(s.addr);
    const html = `📰 ${name}\n${esc(s.label || "")} · ${s.n} recently · latest: <i>${esc(s.latest || "")}</i>`;
    const first = s.unsub ? { text: "Unsubscribe", callback_data: `u:${s.id}` } : { text: "Mute", callback_data: `m:${s.id}` };
    await tg.send(env, u.chatId, html, [[first, { text: "Keep", callback_data: `k:${s.id}` }]]);
    await run(env, "UPDATE senders SET asked_ms = ? WHERE id = ?", now(), s.id);
  }
}

// ---------- the cron ----------

// Bump when the bot's commands change, so the next run re-registers them.
const BOT_SETUP = "4";

async function tick(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return; // deployed before its secrets: nothing to do yet
  if ((await getSetting(env, "bot_setup")) !== `${env.PUBLIC_URL}|${BOT_SETUP}`) {
    await tg.setWebhook(env);
    await tg.setCommands(env);
    await setSetting(env, "bot_setup", `${env.PUBLIC_URL}|${BOT_SETUP}`);
  }

  // A slow run must not overlap the next one and double-notify.
  const lock = Number(await getSetting(env, "lock_until")) || 0;
  if (lock > now()) return;
  await setSetting(env, "lock_until", now() + 4 * 60 * 1000);
  try {
    if (!(await sealLegacySenders(env))) return; // more to seal: carry on next run
    for (const user of await all(env, "SELECT * FROM users ORDER BY is_owner DESC, id")) {
      const u = await person(env, user);
      const accounts = await accountsOf(env, u);
      if (u.owner) await rescue(env, u, accounts);
      for (const account of accounts) {
        if (account.kind === "gmail" && !account.enc_token) continue;
        try {
          await pollAccount(env, u, account, accounts);
        } catch (e) {
          const msg = String(e.message || e).slice(0, 300);
          const prev = account.last_error;
          await run(env, "UPDATE accounts SET last_error = ? WHERE id = ?", msg, account.id);
          // Say so once per new error, not every five minutes.
          if (prev !== msg) await tg.send(env, u.chatId, `⚠️ ${esc(account.label)}: ${esc(msg)}`);
        }
      }
      try {
        await maybeDigest(env, u);
      } catch (e) {
        console.error("digest", user.id, e.message); // a blocked bot must not stop the others
      }
    }
    await run(env, "DELETE FROM messages WHERE created_ms < ?", now() - 30 * DAY);
    await run(env, "DELETE FROM oauth_states WHERE created_ms < ?", now() - 3600 * 1000);
    await run(env, "DELETE FROM invites WHERE used_ms IS NULL AND created_ms < ?", now() - INVITE_DAYS * DAY);
    await run(env, "DELETE FROM join_requests WHERE created_ms < ?", now() - 30 * DAY);
    await run(env, "DELETE FROM drafts WHERE created_ms < ?", now() - DRAFT_MINUTES * 60000);
  } finally {
    await setSetting(env, "lock_until", 0);
  }
}

// ---------- Telegram webhook ----------

async function onCallback(env, u, cb) {
  const chatId = u.chatId;
  const [kind, arg] = cb.data.split(":");
  const msgId = cb.message.message_id;
  const original = esc(cb.message.text || "");

  if (kind === "d") {
    await tg.edit(env, chatId, msgId, `✓ ${original}`);
    return tg.answer(env, cb.id, "Done");
  }

  if (kind === "r" || kind === "f" || kind === "w") return startDraft(env, u, cb, kind, arg, cb.data.split(":").slice(2).join(":"));
  if (kind === "ws") return ruleScope(env, u, cb, arg);
  if (kind === "wd") {
    const gone = await run(env, "DELETE FROM rules WHERE id = ? AND user_id = ?", Number(arg), u.user.id);
    await tg.edit(env, chatId, msgId, gone.meta.changes ? `${original}\n\n<b>Deleted.</b>` : `${original}\n\nAlready gone.`);
    return tg.answer(env, cb.id, "Deleted");
  }
  if (kind === "s") return sendDraft(env, u, cb);
  if (kind === "c") {
    await run(env, "DELETE FROM drafts WHERE user_id = ?", u.user.id);
    await tg.edit(env, chatId, msgId, "Cancelled. Nothing was sent.");
    return tg.answer(env, cb.id, "Cancelled");
  }

  if (kind === "j" && u.owner) return answerRequest(env, u, cb, arg === "a", cb.data.split(":")[2]);

  if (kind === "x") {
    if (arg === "no") {
      await tg.edit(env, chatId, msgId, "Fine, nothing deleted.");
      return tg.answer(env, cb.id, "Kept");
    }
    if (arg === "leave" && !u.owner) {
      await tg.answer(env, cb.id, "Deleting…");
      await dropUser(env, u.user);
      await tg.edit(env, chatId, msgId, "Done. Your inboxes are disconnected, Google's access is handed back, and everything I held for you is deleted. Goodbye.");
      const owner = await ownerUser(env);
      if (owner) await tg.send(env, owner.chat_id, `👋 <b>${esc(u.user.label)}</b> has left Triage. Everything held for them is deleted.`);
      return;
    }
    return tg.answer(env, cb.id, "Not sure what that was");
  }

  const sender = await openRow(u.keys, await one(env, "SELECT * FROM senders WHERE id = ? AND user_id = ?", Number(arg), u.user.id), SENDER_SEALED);
  if (!sender) return tg.answer(env, cb.id, "I no longer know that sender");
  const setRule = (rule) => run(env, "UPDATE senders SET rule = ?, updated_ms = ? WHERE id = ?", rule, now(), sender.id);

  if (kind === "k") {
    await setRule("keep");
    await tg.edit(env, chatId, msgId, `${original}\n\n<b>Kept.</b> I will not ask again.`);
    return tg.answer(env, cb.id, "Kept");
  }
  if (kind === "n" || kind === "m") {
    await setRule("mute");
    const tail = kind === "n" ? "From now on their mail goes in the digest." : "Muted. Their mail goes in the digest, and in act mode it is archived.";
    await tg.edit(env, chatId, msgId, `${original}\n\n<b>${tail}</b>`);
    return tg.answer(env, cb.id, "Muted");
  }
  if (kind === "u") {
    await tg.answer(env, cb.id, "Unsubscribing…");
    try {
      return await unsubscribeTap(env, u, msgId, original, sender, setRule);
    } catch (e) {
      return tg.edit(env, chatId, msgId, `${original}\n\n⚠️ <b>That did not work</b>: ${esc(String(e.message).slice(0, 200))}`, [
        [{ text: "Try again", callback_data: `u:${sender.id}` }],
      ]);
    }
  }
  return tg.answer(env, cb.id, "Not sure what that was");
}

async function unsubscribeTap(env, u, msgId, original, sender, setRule) {
  const account = await accountOf(env, u, sender.account_id);
  const inbox = account ? await openInbox(env, account) : null;
  const result = await unsubscribe(sender, account?.kind === "gmail" ? inbox : null);
  await setRule("unsubscribed");

  // Clear what is already sitting in the inbox from them. This is their tap,
  // so it happens in watch mode too.
  let archived = 0;
  if (inbox) {
    const ids =
      account.kind === "gmail"
        ? await inbox.inboxFrom(sender.addr)
        : (await all(env, "SELECT msg_id FROM messages WHERE account_id = ? AND sender_id = ?", account.id, sender.id)).map((r) => Number(r.msg_id));
    await inbox.archive(ids);
    archived = ids.length;
  }
  const moved = archived ? ` Archived ${archived} of their emails.` : "";
  const outcome = {
    "one-click": `<b>Unsubscribed.</b>${moved} Anything still in the pipeline gets archived.`,
    email: `<b>Unsubscribe email sent.</b>${moved} Anything that still arrives gets archived.`,
    link: `<b>This one needs a click on their page</b>, so I have left it to you. Until then I will archive their mail.${moved}`,
    none: `<b>They give no way to unsubscribe.</b> I will archive their mail from now on.${moved}`,
  }[result.how];
  const buttons = result.how === "link" ? [[{ text: "Open their unsubscribe page", url: result.url }]] : [];
  return tg.edit(env, u.chatId, msgId, `${original}\n\n${outcome}`, buttons);
}

// ---------- Reply and Forward ----------
//
// Both send real email, so both take three steps: tap, type, then a preview
// with Send. The person writes every word; the model writes none. The draft
// (recipient and text) is sealed while it waits, and lapses after
// DRAFT_MINUTES (docs/DECISIONS.md 16).

async function liveDraft(env, u) {
  const d = await one(env, "SELECT * FROM drafts WHERE user_id = ? AND created_ms > ?", u.user.id, now() - DRAFT_MINUTES * 60000);
  return openRow(u.keys, d, ["to_addr", "body"]);
}

async function startDraft(env, u, cb, kind, accountId, msgId) {
  const account = await accountOf(env, u, accountId);
  const row = account && (await one(env, "SELECT * FROM messages WHERE account_id = ? AND msg_id = ?", account.id, msgId));
  if (!account || !row || (kind !== "w" && account.kind !== "gmail")) return tg.answer(env, cb.id, "I no longer have that email");
  await openRow(u.keys, row, MESSAGE_SEALED);
  await run(env, "DELETE FROM drafts WHERE user_id = ?", u.user.id);
  await run(
    env,
    "INSERT INTO drafts (user_id, kind, account_id, msg_id, stage, created_ms) VALUES (?, ?, ?, ?, ?, ?)",
    u.user.id, kind, account.id, msgId, kind === "w" ? "scope" : "text", now(),
  );
  if (kind === "w") {
    await tg.answer(env, cb.id, "Rule");
    const addr = String(row.from_addr || "").toLowerCase();
    return tg.send(env, u.chatId, `⚙️ A forwarding rule for mail like this. Which mail?`, [
      [{ text: `From ${addr}`, callback_data: "ws:s" }],
      [{ text: `All of @${domainOf(addr)}`, callback_data: "ws:d" }],
      [{ text: "Cancel", callback_data: "c" }],
    ]);
  }
  await tg.answer(env, cb.id, kind === "r" ? "Reply" : "Forward");
  const about = `<b>${esc(row.subject || "(no subject)")}</b>`;
  return tg.send(
    env,
    u.chatId,
    kind === "r"
      ? `↩️ Replying to ${esc(row.from_name || row.from_addr)} about ${about}, from ${esc(account.label)}.\n\nType your reply as your next message. You will see it before it goes. /cancel to stop.`
      : `↪️ Forwarding ${about}, from ${esc(account.label)}.\n\nSend the email address to forward it to. Anything on the lines after it goes in as a note. You will see it before it goes. /cancel to stop.`,
  );
}

async function ruleScope(env, u, cb, which) {
  const draft = await liveDraft(env, u);
  if (!draft || draft.kind !== "w" || draft.stage !== "scope") return tg.answer(env, cb.id, "That has lapsed: tap Rule again");
  const row = await openRow(u.keys, await one(env, "SELECT from_addr FROM messages WHERE account_id = ? AND msg_id = ?", draft.account_id, draft.msg_id), ["from_addr"]);
  const addr = String(row?.from_addr || "").toLowerCase();
  if (!EMAIL_RE.test(addr)) return tg.answer(env, cb.id, "I cannot read that sender");
  const match = which === "d" ? `domain:${domainOf(addr)}` : `sender:${addr}`;
  await run(env, "UPDATE drafts SET stage = 'text', body = ?, created_ms = ? WHERE user_id = ?", await S(u, match), now(), u.user.id);
  await tg.answer(env, cb.id, "OK");
  const what = which === "d" ? `everything from @${domainOf(addr)}` : `every email from ${addr}`;
  return tg.edit(env, u.chatId, cb.message.message_id, `⚙️ Forward ${esc(what)}.\n\nSend the address to forward them to. /cancel to stop.`);
}

// "sender:a@b.com" | "domain:b.com" | "topic:invoices" -> { kind, match }
const parseMatch = (s) => {
  const i = s.indexOf(":");
  return { kind: s.slice(0, i), match: s.slice(i + 1) };
};

async function confirmRule(env, u, matchSpec, to) {
  await run(
    env,
    `INSERT INTO drafts (user_id, kind, account_id, msg_id, stage, to_addr, body, created_ms) VALUES (?, 'w', '', '', 'confirm', ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET kind = 'w', stage = 'confirm', to_addr = excluded.to_addr, body = excluded.body, created_ms = excluded.created_ms`,
    u.user.id, await S(u, to), await S(u, matchSpec), now(),
  );
  const rule = { ...parseMatch(matchSpec), to_addr: to };
  const guess = rule.kind === "topic" ? "\n\nClaude judges each email against your description, so it will sometimes guess wrong either way." : "";
  return tg.send(
    env,
    u.chatId,
    `Save this rule? Forward ${esc(describeRule(rule))} to <b>${esc(to)}</b>.\n\nJunk and anything that looks like phishing is never forwarded.${guess}`,
    [[{ text: "Save rule", callback_data: "s" }, { text: "Cancel", callback_data: "c" }]],
  );
}

async function draftText(env, u, draft, text) {
  if (draft.kind === "w") {
    const to = text.split("\n")[0].trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return tg.send(env, u.chatId, "That does not look like an email address. Send just the address, or /cancel.");
    return confirmRule(env, u, draft.body, to);
  }
  const account = await accountOf(env, u, draft.account_id);
  if (!account) return tg.send(env, u.chatId, "That inbox is no longer connected.");
  const preview = (s) => esc(s.length > 1500 ? `${s.slice(0, 1500)} …` : s);
  let to, body;
  if (draft.kind === "r") {
    const inbox = await gmail.open(env, account);
    const orig = await inbox.get(draft.msg_id);
    // Reply-To is set by whoever wrote the email: take one checked address only.
    const addr = parseFrom(orig.replyTo || "").addr;
    to = EMAIL_RE.test(addr) ? addr : orig.from.addr;
    if (!EMAIL_RE.test(to)) return tg.send(env, u.chatId, "I cannot find an address to reply to on that email. /cancel");
    body = text;
  } else {
    const [first, ...restLines] = text.split("\n");
    to = first.trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return tg.send(env, u.chatId, "That does not look like an email address. Send just the address on the first line, or /cancel.");
    body = restLines.join("\n").trim();
  }
  await run(
    env,
    "UPDATE drafts SET stage = 'confirm', to_addr = ?, body = ?, created_ms = ? WHERE user_id = ?",
    await S(u, to), await S(u, body), now(), u.user.id,
  );
  const head = draft.kind === "r" ? `Send this reply to <b>${esc(to)}</b> from ${esc(account.label)}?` : `Forward it to <b>${esc(to)}</b> from ${esc(account.label)}?`;
  const shown = body ? `\n\n<i>${preview(body)}</i>` : "";
  return tg.send(env, u.chatId, `${head}${shown}`, [[{ text: "Send", callback_data: "s" }, { text: "Cancel", callback_data: "c" }]]);
}

async function sendDraft(env, u, cb) {
  const draft = await liveDraft(env, u);
  if (!draft || draft.stage !== "confirm") {
    await tg.edit(env, u.chatId, cb.message.message_id, "That draft has lapsed, so nothing was sent. Tap Reply or Forward again.");
    return tg.answer(env, cb.id, "Lapsed");
  }
  // Delete first: a double tap must never send twice.
  const took = await run(env, "DELETE FROM drafts WHERE user_id = ? AND stage = 'confirm'", u.user.id);
  if (!took.meta.changes) return tg.answer(env, cb.id, "Already sent");
  if (draft.kind === "w") {
    const rule = parseMatch(draft.body);
    const key = rule.kind === "sender" ? await addrKey(u.keys, rule.match) : rule.kind === "domain" ? await addrKey(u.keys, "@" + rule.match) : null;
    await run(
      env,
      "INSERT INTO rules (user_id, kind, match_key, match, to_addr, created_ms) VALUES (?, ?, ?, ?, ?, ?)",
      u.user.id, rule.kind, key, await S(u, rule.match), await S(u, draft.to_addr), now(),
    );
    await tg.answer(env, cb.id, "Saved");
    return tg.edit(env, u.chatId, cb.message.message_id, `✅ Rule saved: forward ${esc(describeRule({ ...rule }))} to <b>${esc(draft.to_addr)}</b>. It applies to mail arriving from now on. /rules lists your rules.`);
  }
  await tg.answer(env, cb.id, "Sending…");
  try {
    const account = await accountOf(env, u, draft.account_id);
    if (!account) throw new Error("that inbox is no longer connected");
    const inbox = await gmail.open(env, account);
    if (draft.kind === "r") {
      const orig = await inbox.get(draft.msg_id);
      const mime = buildReply({ to: draft.to_addr, subject: orig.subject, body: draft.body, inReplyTo: orig.messageId, references: orig.references });
      await inbox.sendInThread(mime, orig.threadId);
    } else {
      const raw = await inbox.raw(draft.msg_id);
      const fwd = await buildForward(raw, { to: draft.to_addr, received: Date.now(), note: draft.body });
      await inbox.sendMime(fwd.mime);
    }
    return tg.edit(env, u.chatId, cb.message.message_id, `✅ ${draft.kind === "r" ? "Reply sent" : "Forwarded"} to <b>${esc(draft.to_addr)}</b>.`);
  } catch (e) {
    return tg.edit(env, u.chatId, cb.message.message_id, `⚠️ Not sent: ${esc(String(e.message || e).slice(0, 200))}. Tap Reply or Forward on the alert to try again.`);
  }
}

const HELP_TOP = `I watch your inboxes and only bother you about what needs you.

🔴 Needs you: I message you straight away.
📬 Everything else: a digest at 8am and 5pm (UK time).
📰 Newsletters: I ask once per sender, Unsubscribe or Keep.
↩️ Reply and ↪️ Forward on an alert: you type it, see it, then tap Send.
⚙️ Rule on an alert: always forward mail like it somewhere.

/rule invoices to someone@example.com: forward a kind of email
/rules: your rules, with Delete buttons

/status: what is connected
/digest: send the digest now
/mode watch: I sort and tell you, but never touch your mailbox on my own
/mode act: I also archive newsletters and junk`;

const HELP_OWNER = `${HELP_TOP}
/connect HW Gmail: connect a Google inbox
/connect iCloud you@icloud.com: connect iCloud
/disconnect HW Gmail: disconnect one and delete what I hold for it

Guests (people can also ask to join at https://triage.hw-tools.io):
/invite Erica: a single-use invite link for someone
/guests: who has joined, and pending invites
/remove Erica: close their Triage and delete all of it`;

const HELP_GUEST = `${HELP_TOP}
/connect Gmail: connect a Gmail or Google Workspace inbox (any name you like)
/disconnect Gmail: disconnect one and delete what I hold for it
/privacy: what I keep and who can see it
/leave: disconnect everything and delete all I hold for you`;

const PRIVACY_GUEST = `<b>What I keep, and who can see it</b>

• I read new mail in the inboxes you connect, and send each one to Anthropic's Claude to be sorted. Anthropic does not train on it.
• I never store the body of an email. For 30 days I keep who it was from, the subject and a one-line summary, so the digest and the newsletter questions work.
• All of that, your inbox addresses and your rules are encrypted under a key of your own before they are stored. Helen runs Triage but does not see your mail: browsing the database shows nothing readable.
• Your Google access is encrypted too. You can withdraw it at any time at https://myaccount.google.com/permissions.
• Helen can see only that you joined and how many inboxes you connected, never which ones.
• /leave deletes all of it at once.

In fairness: Helen owns the service, so this rests on trust as well as on encryption. It is built so that she never sees your mail, and she has promised not to look.`;

function welcomeGuest(label) {
  return `Hello ${esc(label)}. Welcome to Triage.

I watch your email and only bother you about what needs you. Your mail stays private: see /privacy.

<b>To start:</b> send /connect Gmail (or any name, like /connect Work). I will send a button to sign in with Google.

Google will warn that it "hasn't verified this app". That is because Triage is a small private tool, not a public product. Tap <b>Advanced</b>, then <b>Go to triage.hw-tools.io</b>, then allow access.

I start in <b>watch</b> mode: I sort and tell you, and never touch your mailbox unless you tap a button.

/help shows everything I can do.`;
}

async function botUsername(env) {
  let name = await getSetting(env, "bot_username");
  if (!name) {
    name = (await tg.getMe(env)).username;
    await setSetting(env, "bot_username", name);
  }
  return name;
}

async function onOwnerCommand(env, u, cmd, arg) {
  if (cmd === "/invite") {
    if (!arg) return tg.send(env, u.chatId, "Say who it is for: /invite Erica");
    const taken = await one(env, "SELECT 1 FROM users WHERE label = ? COLLATE NOCASE", arg);
    if (taken) return tg.send(env, u.chatId, `There is already someone called <b>${esc(arg)}</b>. Pick another name.`);
    const code = randomToken(18);
    await run(env, "INSERT INTO invites (code, label, created_ms) VALUES (?, ?, ?)", code, arg, now());
    const link = `https://t.me/${await botUsername(env)}?start=${code}`;
    return tg.send(
      env,
      u.chatId,
      `Invite for <b>${esc(arg)}</b>. Send them this link. It works once, for ${INVITE_DAYS} days, and whoever opens it first becomes ${esc(arg)}:\n\n${link}`,
    );
  }
  if (cmd === "/guests") {
    const guests = await all(
      env,
      `SELECT u.label, u.created_ms, COUNT(a.id) AS n, SUM(a.last_error IS NOT NULL) AS bad
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.is_owner = 0 GROUP BY u.id ORDER BY u.label`,
    );
    const pending = await all(env, "SELECT label, created_ms FROM invites WHERE used_ms IS NULL AND created_ms > ? ORDER BY created_ms", now() - INVITE_DAYS * DAY);
    const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const lines = ["<b>Guests</b>"];
    for (const g of guests) {
      const inboxes = g.n ? `${g.n} inbox${g.n > 1 ? "es" : ""}${g.bad ? `, ${g.bad} with a problem` : ""}` : "nothing connected yet";
      lines.push(`• <b>${esc(g.label)}</b>: joined ${date(g.created_ms)}, ${inboxes}`);
    }
    if (!guests.length) lines.push("None yet. /invite Erica");
    const asks = await all(env, "SELECT name, username FROM join_requests WHERE status = 'pending' ORDER BY created_ms");
    if (asks.length) {
      lines.push("", "<b>Asking to join</b> (the Approve buttons are on each request)");
      for (const a of asks) lines.push(`• ${esc(a.name)}${a.username ? ` (@${esc(a.username)})` : ""}`);
    }
    if (pending.length) {
      lines.push("", "<b>Invites not yet used</b>");
      for (const p of pending) lines.push(`• ${esc(p.label)}, made ${date(p.created_ms)}`);
    }
    return tg.send(env, u.chatId, lines.join("\n"));
  }
  if (cmd === "/remove") {
    if (!arg) return tg.send(env, u.chatId, "Say who: /remove Erica");
    const dropped = await run(env, "DELETE FROM invites WHERE label = ? COLLATE NOCASE AND used_ms IS NULL", arg);
    const guest = await one(env, "SELECT * FROM users WHERE label = ? COLLATE NOCASE AND is_owner = 0", arg);
    if (guest) {
      await dropUser(env, guest);
      await tg.send(env, guest.chat_id, "Helen has closed your Triage. Your inboxes are disconnected, Google's access is handed back, and everything I held for you is deleted.").catch(() => {});
      return tg.send(env, u.chatId, `Removed <b>${esc(guest.label)}</b> and deleted everything held for them.`);
    }
    if (dropped.meta.changes) return tg.send(env, u.chatId, `Cancelled the invite for <b>${esc(arg)}</b>.`);
    return tg.send(env, u.chatId, `No guest or invite called <b>${esc(arg)}</b>. /guests lists them.`);
  }
  return null;
}

async function onMessage(env, u, m) {
  const chatId = u.chatId;
  const text = (m.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");

  if (cmd === "/rules") {
    const rules = await rulesOf(env, u);
    if (!rules.length) return tg.send(env, chatId, "No rules yet. Tap ⚙️ Rule on an alert, or send /rule invoices to someone@example.com");
    for (const r of rules) {
      const used = r.used ? ` Used ${r.used} time${r.used > 1 ? "s" : ""}.` : " Not used yet.";
      await tg.send(env, chatId, `⚙️ Forward ${esc(describeRule(r))} to <b>${esc(r.to_addr)}</b>.${used}`, [[{ text: "Delete", callback_data: `wd:${r.id}` }]]);
    }
    return;
  }
  if (cmd === "/rule") {
    // /rule [forward] <what> to <address>. <what> is "from a@b.com", "from @b.com", or a description.
    const m = arg.replace(/^forward\s+/i, "").match(/^(.+)\s+to\s+(\S+)$/is);
    const to = m?.[2]?.toLowerCase();
    if (!m || !EMAIL_RE.test(to)) {
      return tg.send(env, chatId, "Say what and where, for example:\n/rule invoices to accounts@example.com\n/rule from @example.co.uk to family@example.com\n/rule from agent@example.co.uk to family@example.com");
    }
    const what = m[1].trim();
    const from = what.match(/^from\s+(\S+)$/i)?.[1]?.toLowerCase();
    if (from?.startsWith("@") && /^@[^\s@]+\.[a-z]{2,}$/i.test(from)) return confirmRule(env, u, `domain:${from.slice(1)}`, to);
    if (from && EMAIL_RE.test(from)) return confirmRule(env, u, `sender:${from}`, to);
    return confirmRule(env, u, `topic:${what.slice(0, 200)}`, to);
  }
  if (cmd === "/cancel") {
    const had = await run(env, "DELETE FROM drafts WHERE user_id = ?", u.user.id);
    return tg.send(env, chatId, had.meta.changes ? "Cancelled. Nothing was sent." : "Nothing to cancel.");
  }
  if (text && !text.startsWith("/")) {
    const draft = await liveDraft(env, u);
    if (draft?.stage === "text") return draftText(env, u, draft, (m.text || "").trim());
  }

  if (u.owner && ["/invite", "/guests", "/remove"].includes(cmd)) return onOwnerCommand(env, u, cmd, arg);

  if (cmd === "/status") {
    const accts = await accountsOf(env, u);
    const lines = [`Mode: <b>${u.user.mode}</b>`, ""];
    for (const a of accts) {
      const ok = a.last_ok_at ? `checked ${Math.round((now() - a.last_ok_at) / 60000)} min ago` : "not checked yet";
      lines.push(`${a.last_error ? "⚠️" : "✅"} <b>${esc(a.label)}</b> ${esc(a.email || "")}: ${ok}${a.last_error ? `\n   ${esc(a.last_error)}` : ""}`);
    }
    if (!accts.length) lines.push(`No inboxes connected yet. /connect ${u.owner ? "HW Gmail" : "Gmail"}`);
    const today = await one(
      env,
      `SELECT COUNT(*) AS n, SUM(m.category = 'needs_you') AS y FROM messages m JOIN accounts a ON a.id = m.account_id
       WHERE a.user_id = ? AND m.created_ms > ?`,
      u.user.id,
      now() - DAY,
    );
    lines.push("", `Last 24 hours: ${today.n || 0} emails, ${today.y || 0} needed you.`);
    return tg.send(env, chatId, lines.join("\n"));
  }
  if (cmd === "/digest") return sendDigest(env, u);
  if (cmd === "/privacy" && !u.owner) return tg.send(env, chatId, PRIVACY_GUEST);
  if (cmd === "/mode") {
    if (!["watch", "act"].includes(arg)) return tg.send(env, chatId, `Mode is <b>${u.user.mode}</b>. Say /mode watch or /mode act.`);
    await run(env, "UPDATE users SET mode = ? WHERE id = ?", arg, u.user.id);
    return tg.send(env, chatId, arg === "act" ? "Act mode: I will archive newsletters, junk and muted senders as they arrive." : "Watch mode: I sort and tell you, and only touch your mailbox when you tap a button.");
  }
  if (cmd === "/leave") {
    if (u.owner) return tg.send(env, chatId, "You own Triage, so you cannot leave it. /disconnect removes one inbox.");
    return tg.send(env, chatId, "This disconnects every inbox, hands Google's access back and deletes everything I hold for you. Sure?", [
      [{ text: "Yes, delete everything", callback_data: "x:leave" }, { text: "No", callback_data: "x:no" }],
    ]);
  }
  if (cmd === "/disconnect") {
    const accts = await accountsOf(env, u);
    const a = accts.find((x) => x.label.toLowerCase() === arg.toLowerCase());
    if (!a) return tg.send(env, chatId, `Say which one: ${accts.map((x) => `/disconnect ${esc(x.label)}`).join(", ") || "nothing is connected"}`);
    await dropAccount(env, a);
    return tg.send(env, chatId, `Disconnected <b>${esc(a.label)}</b> and deleted what I held for it.`);
  }
  if (cmd === "/connect") {
    if (!arg) return tg.send(env, chatId, u.owner ? "Say which: /connect HW Gmail, or /connect iCloud you@icloud.com" : "Give it a name: /connect Gmail, or /connect Work");
    const icloudAddr = arg.match(/[^\s]+@(icloud|me|mac)\.com/i)?.[0];
    if (icloudAddr || /^icloud$/i.test(arg)) {
      // iCloud needs an app password, which only Helen's runs on so far.
      if (!u.owner || !icloudAddr) return tg.send(env, chatId, "I can only connect Gmail and Google Workspace inboxes for now, not iCloud.");
      const label = arg.replace(icloudAddr, "").trim() || "iCloud";
      await run(
        env,
        `INSERT INTO accounts (id, user_id, kind, label, email, cursor_ms) VALUES (?, ?, 'icloud', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, last_error = NULL WHERE accounts.user_id = excluded.user_id`,
        slug(label), u.user.id, label, icloudAddr.toLowerCase(), now(),
      );
      return tg.send(env, chatId, `Connected <b>${esc(label)}</b>. I will check it within five minutes; /status shows if the login worked.`);
    }
    // Reconnecting a name they already use replaces that inbox's access.
    const existing = (await accountsOf(env, u)).find((x) => x.label.toLowerCase() === arg.toLowerCase());
    const accountId = existing?.id || (u.owner ? slug(arg) : `u${u.user.id}-${randomToken(6)}`);
    const state = randomToken();
    await run(
      env,
      "INSERT INTO oauth_states (state, account_id, user_id, label, created_ms) VALUES (?, ?, ?, ?, ?)",
      state, accountId, u.user.id, await S(u, arg), now(),
    );
    return tg.send(env, chatId, `Sign in to the Google account you call <b>${esc(arg)}</b>. The link works once, for an hour.`, [
      [{ text: `Connect ${arg}`, url: gmail.authUrl(env, state) }],
    ]);
  }
  return tg.send(env, chatId, u.owner ? HELP_OWNER : HELP_GUEST);
}

// Someone with no row yet. Two ways in: Helen's one-time pairing code (only while
// there is no owner), or an unused, unexpired invite. Everyone else gets silence.
async function onStranger(env, m, chatId) {
  const [cmd, code] = (m.text || "").trim().split(/\s+/);
  if (cmd !== "/start" || !code) return;

  if (!(await ownerUser(env))) {
    if (env.PAIR_CODE && code === env.PAIR_CODE) {
      await run(env, "INSERT INTO users (chat_id, label, is_owner, created_ms) VALUES (?, 'Helen', 1, ?)", chatId, now());
      return tg.send(env, chatId, `Hello Helen. Paired.\n\n${HELP_OWNER}`);
    }
    return;
  }

  if (code === "join") return askToJoin(env, m, chatId);

  // Claim the invite first, so two people racing for one link cannot both get in.
  const claimed = await run(
    env,
    "UPDATE invites SET used_ms = ? WHERE code = ? AND used_ms IS NULL AND created_ms > ?",
    now(), code, now() - INVITE_DAYS * DAY,
  );
  if (!claimed.meta.changes) return;
  const invite = await one(env, "SELECT * FROM invites WHERE code = ?", code);
  const userId = await admit(env, chatId, invite.label);
  await run(env, "UPDATE invites SET user_id = ? WHERE code = ?", userId, code);
  const owner = await ownerUser(env);
  if (owner) await tg.send(env, owner.chat_id, `✅ <b>${esc(invite.label)}</b> has joined Triage.`);
}

// Makes someone a guest and says hello. The name is Helen's handle for them in
// /guests and /remove, so it is made unique.
async function admit(env, chatId, name) {
  const base = String(name || "Guest").trim().slice(0, 40) || "Guest";
  let label = base;
  for (let n = 2; await one(env, "SELECT 1 FROM users WHERE label = ? COLLATE NOCASE", label); n++) label = `${base} ${n}`;
  const res = await run(env, "INSERT INTO users (chat_id, label, created_ms) VALUES (?, ?, ?)", chatId, label, now());
  await tg.send(env, chatId, welcomeGuest(label));
  return res.meta.last_row_id;
}

// Someone tapped Ask to join on the public page. Helen gets their Telegram name
// and two buttons; nobody is let in without her tap (docs/DECISIONS.md 15).
async function askToJoin(env, m, chatId) {
  const prior = await one(env, "SELECT * FROM join_requests WHERE chat_id = ?", chatId);
  if (prior?.status === "pending") return tg.send(env, chatId, "You have already asked. Helen will see it, and I will tell you here when she says yes.");
  if (prior?.status === "declined") return; // asked and declined in the last 30 days
  const waiting = await one(env, "SELECT COUNT(*) AS n FROM join_requests WHERE status = 'pending'");
  if (waiting.n >= MAX_PENDING_REQUESTS) return tg.send(env, chatId, "Triage is not taking new requests just now. Please try again in a while.");

  const f = m.from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ").trim().slice(0, 60) || "Someone";
  const res = await run(
    env,
    "INSERT INTO join_requests (chat_id, name, username, created_ms) VALUES (?, ?, ?, ?)",
    chatId, name, f.username || null, now(),
  );
  await tg.send(env, chatId, `Thanks, ${esc(name)}. I have asked Helen. When she says yes I will say hello here, and you can connect your inbox.`);
  const owner = await ownerUser(env);
  if (!owner) return;
  const handle = f.username ? ` (@${esc(f.username)})` : "";
  await tg.send(env, owner.chat_id, `🙋 <b>${esc(name)}</b>${handle} asks to join Triage.`, [
    [
      { text: "Approve", callback_data: `j:a:${res.meta.last_row_id}` },
      { text: "Decline", callback_data: `j:d:${res.meta.last_row_id}` },
    ],
  ]);
}

async function answerRequest(env, u, cb, yes, id) {
  const req = await one(env, "SELECT * FROM join_requests WHERE id = ? AND status = 'pending'", Number(id));
  if (!req) return tg.answer(env, cb.id, "Already dealt with");
  if (yes) {
    await run(env, "DELETE FROM join_requests WHERE id = ?", req.id);
    if (await one(env, "SELECT 1 FROM users WHERE chat_id = ?", req.chat_id)) return tg.answer(env, cb.id, "They are already in");
    await admit(env, req.chat_id, req.name);
    await tg.edit(env, u.chatId, cb.message.message_id, `✅ <b>${esc(req.name)}</b> approved and welcomed. /guests lists them.`);
    return tg.answer(env, cb.id, "Approved");
  }
  await run(env, "UPDATE join_requests SET status = 'declined' WHERE id = ?", req.id);
  await tg.send(env, req.chat_id, "Helen is not adding anyone new to Triage just now. Thank you for asking.").catch(() => {});
  await tg.edit(env, u.chatId, cb.message.message_id, `Declined <b>${esc(req.name)}</b>. They cannot ask again for 30 days.`);
  return tg.answer(env, cb.id, "Declined");
}

async function onTelegram(env, update) {
  const m = update.message;
  const cb = update.callback_query;
  const chat = m?.chat || cb?.message?.chat;
  // Private chats only: no groups, no channels.
  if (!chat || chat.type !== "private") return;
  const chatId = String(chat.id);

  const user = await one(env, "SELECT * FROM users WHERE chat_id = ?", chatId);
  if (!user) return m ? onStranger(env, m, chatId) : undefined;
  const u = await person(env, user);
  if (m) return onMessage(env, u, m);
  return onCallback(env, u, cb);
}

const page = (title, body) =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;padding:2rem;max-width:30rem"><h1>${title}</h1><p>${body}</p>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

async function onOAuthCallback(env, url) {
  const state = url.searchParams.get("state");
  const row = state && (await one(env, "SELECT * FROM oauth_states WHERE state = ? AND created_ms > ?", state, now() - 3600 * 1000));
  if (!row) return page("Link expired", "Ask the bot for a fresh one with /connect.");
  await run(env, "DELETE FROM oauth_states WHERE state = ?", state);
  const user = await one(env, "SELECT * FROM users WHERE id = ?", row.user_id);
  if (!user) return page("Not connected", "This Triage has been closed.");
  const u = await person(env, user);
  const label = await openWith(u.keys, row.label);
  if (url.searchParams.get("error")) return page("Not connected", "Google said no. Ask the bot for a fresh link with /connect.");

  let tokens, email;
  try {
    tokens = await gmail.exchangeCode(env, url.searchParams.get("code"));
    email = await gmail.profileEmail(tokens.access_token);
  } catch (e) {
    console.error("oauth", e.message);
    return page("Not connected", `Google did not finish the connection (${esc(e.message)}). Ask the bot for a fresh link with /connect.`);
  }
  await run(
    env,
    `INSERT INTO accounts (id, user_id, kind, label, email, enc_token, cursor_ms) VALUES (?, ?, 'gmail', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, enc_token = excluded.enc_token, last_error = NULL
     WHERE accounts.user_id = excluded.user_id`,
    row.account_id, u.user.id, await S(u, label), await S(u, email), await seal(env, tokens.refresh_token), now(),
  );
  await tg.send(env, u.chatId, `Connected <b>${esc(label)}</b> (${esc(email)}). I will only look at mail arriving from now on.`);
  return page("Connected", `${esc(label)} is connected. You can close this tab and go back to Telegram.`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // The page itself is web/, served before the Worker. Google's consent screen
    // links /privacy, which is a section of that page.
    if (url.pathname === "/privacy") return Response.redirect(`${env.PUBLIC_URL}/#privacy`, 301);

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("no", { status: 401 });
      const update = await request.json();
      // Answer Telegram at once; an unsubscribe can take a few seconds.
      ctx.waitUntil(onTelegram(env, update).catch((e) => console.error("telegram", e.message)));
      return new Response("ok");
    }

    if (url.pathname === "/oauth/callback") return onOAuthCallback(env, url);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
