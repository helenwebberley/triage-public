// Travel bookings go on to the owner's travel desk (TRAVEL_TO), an address that
// turns them into trips. The desk accepts mail only from a short list of the
// owner's addresses, so the forward is always sent from one of the Google
// inboxes named in TRAVEL_FROM, whichever inbox the booking arrived in.
//
// The model only says "this is travel". The address it goes to is fixed in
// wrangler.toml, so nothing in an email can choose where it is sent.

import PostalMime from "postal-mime";
import { htmlToText } from "./mail.js";

const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024; // the travel desk reads no more than this either

export function travelSenders(env) {
  return String(env.TRAVEL_FROM || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// The connected Google account to send from: the one the mail came to if it is
// allowed, otherwise the first allowed one that is connected.
export function pickSender(env, account, accounts) {
  const allowed = travelSenders(env);
  const ok = (a) => a.kind === "gmail" && a.enc_token && allowed.includes(String(a.email || "").toLowerCase());
  if (ok(account)) return account;
  return allowed.map((e) => accounts.find((a) => ok(a) && a.email.toLowerCase() === e)).find(Boolean) || null;
}

const b64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
const utf8b64 = (s) => wrap(b64(new TextEncoder().encode(s)));
// RFC 2047, so a subject or file name with accents survives.
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`);
const clean = (s) => String(s || "").replace(/[\r\n"]+/g, " ").trim();

// Builds a plain forward, the way a mail app does it: the original's headers and
// text in the body, its files attached. Returns the RFC 822 bytes as a string.
export async function buildForward(raw, { to, received, note = "" }) {
  const p = await PostalMime.parse(raw, { attachmentEncoding: "base64" });
  const from = p.from ? (p.from.name ? `${p.from.name} <${p.from.address}>` : p.from.address) : "";
  const text = [
    ...(note ? [note, ""] : []),
    "---------- Forwarded message ---------",
    `From: ${from}`,
    `Date: ${p.date || new Date(received).toUTCString()}`,
    `Subject: ${p.subject || ""}`,
    `To: ${(p.to || []).map((t) => t.address).join(", ")}`,
    "",
    (p.text || "").trim() || htmlToText(p.html || ""),
  ].join("\n");

  const files = [];
  let total = 0;
  for (const a of p.attachments || []) {
    if (a.related || (a.disposition === "inline" && !a.filename)) continue; // the email's own logos
    const size = Math.floor((a.content.length * 3) / 4);
    if (files.length >= MAX_FILES || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    files.push(a);
  }

  const boundary = `triage-${crypto.randomUUID()}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${word(`Fwd: ${clean(p.subject) || "(no subject)"}`)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    utf8b64(text),
  ];
  for (const a of files) {
    const name = word(clean(a.filename) || "attachment");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${clean(a.mimeType) || "application/octet-stream"}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(a.content),
    );
  }
  lines.push(`--${boundary}--`, "");
  return { mime: lines.join("\r\n"), files: files.length, subject: p.subject || "(no subject)" };
}

// A plain-text reply the person typed themselves, threaded to the original.
// Every header value is stripped of line breaks, so nothing in the original
// email can add a header of its own.
export function buildReply({ to, subject, body, inReplyTo, references }) {
  const subj = clean(subject) || "(no subject)";
  const id = clean(inReplyTo);
  const lines = [
    `To: ${clean(to)}`,
    `Subject: ${word(/^re:/i.test(subj) ? subj : `Re: ${subj}`)}`,
    ...(id ? [`In-Reply-To: ${id}`, `References: ${[clean(references), id].filter(Boolean).join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    utf8b64(body),
  ];
  return lines.join("\r\n");
}
