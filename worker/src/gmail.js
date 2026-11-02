// Gmail API for Google inboxes (Gmail and Google Workspace).
// One OAuth client, one refresh token per inbox, scope gmail.modify: read,
// label, archive and send, never permanent delete.

import { parseFrom, htmlToText, clip } from "./mail.js";
import { unseal } from "./seal.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export function authUrl(env, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/oauth/callback`,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(env, code) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.PUBLIC_URL}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(`token exchange failed: ${j.error || r.status}`);
  return j;
}

async function accessToken(env, account) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await unseal(env, account.enc_token),
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  // No label or address in the text: errors are stored unsealed in D1.
  if (!r.ok) throw new Error(`Google access failed: ${j.error || r.status}`);
  return j.access_token;
}

// Hands the access back to Google when someone disconnects or leaves. Best
// effort: a token Google has already dropped is fine.
export async function revoke(env, account) {
  if (!account.enc_token) return;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: await unseal(env, account.enc_token) }),
    });
  } catch {
    // nothing to do: the row is deleted either way
  }
}

async function call(token, path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`gmail ${path.split("?")[0]} ${r.status}`);
  return r.status === 204 ? null : r.json();
}

export async function profileEmail(accessTok) {
  return (await call(accessTok, "/profile")).emailAddress;
}

// A session object so one poll refreshes the access token once, not per call.
export async function open(env, account) {
  const token = await accessToken(env, account);
  return {
    // Inbox mail received after sinceMs, oldest first, at most `max`.
    async listNew(sinceMs, max) {
      const q = `in:inbox after:${Math.floor(sinceMs / 1000) - 60}`;
      const j = await call(token, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
      return (j.messages || []).map((m) => m.id).reverse();
    },

    async get(id) {
      const m = await call(token, `/messages/${id}?format=full`);
      return normalise(account, m);
    },

    async archive(ids) {
      if (!ids.length) return;
      await call(token, "/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({ ids, removeLabelIds: ["INBOX"] }),
      });
    },

    async unarchive(ids) {
      if (!ids.length) return;
      await call(token, "/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({ ids, addLabelIds: ["INBOX"] }),
      });
    },

    // Inbox mail from one address, for archiving after an unsubscribe.
    async inboxFrom(addr, max = 100) {
      const q = `in:inbox from:${addr}`;
      const j = await call(token, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
      return (j.messages || []).map((m) => m.id);
    },

    // The whole original, for forwarding a booking with its attachments.
    async raw(id) {
      const m = await call(token, `/messages/${id}?format=raw`);
      return Uint8Array.from(atob(m.raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    },

    // Sends a ready-made RFC 822 message. The upload endpoint takes up to 35 MB,
    // which a booking with a PDF or two can need.
    async sendMime(mime) {
      const r = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "message/rfc822" },
        body: mime,
      });
      if (!r.ok) throw new Error(`gmail send ${r.status}`);
    },

    // A ready-made RFC 822 reply, kept in the original's Gmail thread.
    async sendInThread(mime, threadId) {
      const raw = btoa(unescape(encodeURIComponent(mime))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await call(token, "/messages/send", { method: "POST", body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) });
    },

    // The RFC 2369 mailto: route. Sent from the inbox the newsletter arrived in.
    async send({ to, subject, body }) {
      const raw = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
      const enc = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await call(token, "/messages/send", { method: "POST", body: JSON.stringify({ raw: enc }) });
    },
  };
}

function b64urlDecode(data = "") {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bodyText(payload) {
  let plain = "";
  let html = "";
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64urlDecode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = b64urlDecode(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return plain.trim() || htmlToText(html);
}

export function normalise(account, m) {
  const h = {};
  for (const { name, value } of m.payload?.headers || []) h[name.toLowerCase()] = value;
  return {
    accountId: account.id,
    accountLabel: account.label,
    msgId: m.id,
    threadId: m.threadId,
    from: parseFrom(h.from),
    to: h.to || "",
    cc: h.cc || "",
    subject: h.subject || "(no subject)",
    receivedMs: Number(m.internalDate) || Date.now(),
    messageId: h["message-id"] || "",
    references: h.references || "",
    replyTo: h["reply-to"] || "",
    listUnsub: h["list-unsubscribe"] || "",
    listUnsubPost: h["list-unsubscribe-post"] || "",
    listId: h["list-id"] || "",
    precedence: h.precedence || "",
    autoSubmitted: h["auto-submitted"] || "",
    gmailLabels: (m.labelIds || []).filter((l) => l.startsWith("CATEGORY_") || l === "SPAM" || l === "IMPORTANT"),
    text: clip(bodyText(m.payload) || m.snippet || "", 3000),
    link: account.email ? `https://mail.google.com/mail/u/${account.email}/#all/${m.threadId}` : null,
  };
}
