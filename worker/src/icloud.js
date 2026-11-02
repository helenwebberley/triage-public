// iCloud Mail over IMAP. Apple has no mail API, so this is the one inbox read
// the old way. Login is the Apple ID plus an app-specific password (Worker secret
// ICLOUD_APP_PASSWORD), never the real Apple ID password.

import { connect } from "cloudflare:sockets";
import PostalMime from "postal-mime";
import { Imap } from "./imap.js";
import { htmlToText, clip } from "./mail.js";

const HOST = "imap.mail.me.com";

async function session(env, account) {
  const socket = connect({ hostname: HOST, port: 993 }, { secureTransport: "on" });
  const imap = new Imap(socket);
  await imap.greeting();
  await imap.login(account.email, env.ICLOUD_APP_PASSWORD);
  await imap.select("INBOX");
  return { imap, socket };
}

async function withSession(env, account, fn) {
  const { imap, socket } = await session(env, account);
  try {
    return await fn(imap);
  } finally {
    await imap.logout();
    socket.close();
  }
}

export async function open(env, account) {
  return {
    // Takes isSeen so it only downloads mail it has not judged before.
    async fetchNew(sinceMs, max, isSeen) {
      return withSession(env, account, async (imap) => {
        const since = new Date(sinceMs - 24 * 3600 * 1000);
        const uids = (await imap.searchSince(since)).sort((a, b) => a - b);
        const fresh = [];
        for (const uid of uids) if (!(await isSeen(String(uid)))) fresh.push(uid);
        const heads = await imap.fetchHeads(fresh.slice(0, max));
        const out = [];
        for (const h of heads) {
          if (h.internalDate < sinceMs - 60_000) continue;
          out.push(await normalise(account, h));
        }
        return out;
      });
    },

    // The whole original, for forwarding a booking with its attachments.
    async raw(uid) {
      return withSession(env, account, async (imap) => (await imap.fetchHeads([Number(uid)], 0))[0]?.raw);
    },

    async archive(uids) {
      if (!uids.length) return;
      await withSession(env, account, (imap) => imap.move(uids, "Archive"));
    },
  };
}

async function normalise(account, h) {
  const p = await PostalMime.parse(h.raw);
  const header = (k) => p.headers.find((x) => x.key === k)?.value || "";
  return {
    accountId: account.id,
    accountLabel: account.label,
    msgId: String(h.uid),
    threadId: null,
    from: { name: p.from?.name || "", addr: (p.from?.address || "").toLowerCase() },
    to: header("to"),
    cc: header("cc"),
    subject: p.subject || "(no subject)",
    receivedMs: h.internalDate,
    listUnsub: header("list-unsubscribe"),
    listUnsubPost: header("list-unsubscribe-post"),
    listId: header("list-id"),
    precedence: header("precedence"),
    autoSubmitted: header("auto-submitted"),
    gmailLabels: [],
    text: clip((p.text || "").trim() || htmlToText(p.html || ""), 3000),
    link: null,
  };
}
