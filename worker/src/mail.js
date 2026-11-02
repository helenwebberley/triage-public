// Pure helpers over email headers. No I/O here, so test/ can cover all of it.

// "Stripe <noreply@stripe.com>" -> { name: "Stripe", addr: "noreply@stripe.com" }
export function parseFrom(raw = "") {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), addr: m[2].trim().toLowerCase() };
  const bare = raw.match(/[^\s<>"]+@[^\s<>"]+/);
  return { name: "", addr: bare ? bare[0].toLowerCase() : raw.trim().toLowerCase() };
}

// List-Unsubscribe is a comma-separated list of <uri> entries (RFC 2369).
// Returns the first https URL and the first mailto URL, either may be null.
export function parseListUnsubscribe(header = "") {
  const uris = [...String(header).matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return {
    https: uris.find((u) => /^https:\/\//i.test(u)) || null,
    mailto: uris.find((u) => /^mailto:/i.test(u)) || null,
  };
}

// RFC 8058: one-click is only promised when List-Unsubscribe-Post says so AND
// there is an https URL to POST to. Anything else is not safe to automate.
export function isOneClick(unsub, unsubPost) {
  return /List-Unsubscribe=One-Click/i.test(unsubPost || "") && !!parseListUnsubscribe(unsub).https;
}

// mailto:unsub@x.com?subject=unsubscribe&body=... -> { to, subject, body }
export function parseMailto(uri) {
  const u = new URL(uri);
  return {
    to: decodeURIComponent(u.pathname),
    subject: u.searchParams.get("subject") || "unsubscribe",
    body: u.searchParams.get("body") || "unsubscribe",
  };
}

// Plain text from an HTML body, good enough to show a model what an email says.
export function htmlToText(html = "") {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function clip(text = "", n = 3000) {
  return text.length > n ? text.slice(0, n) + " …" : text;
}

// Telegram HTML parse mode needs these three escaped and nothing else.
export function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Every address in a To or Cc header, lower-cased.
export function addrList(raw = "") {
  return [...String(raw).matchAll(/[^\s<>",;:]+@[^\s<>",;]+/g)].map((m) => m[0].toLowerCase().replace(/[>.]+$/, ""));
}

// A copy of someone else's mail (COPIES_OF): from or to them, and not addressed
// to the owner. When the owner is in To or Cc it is their mail too.
export function isCopyOf(msg, other, mine) {
  if (!other) return false;
  const o = other.toLowerCase();
  const addressed = addrList(`${msg.to}, ${msg.cc || ""}`);
  if (addressed.some((a) => mine.includes(a))) return false;
  return msg.from.addr === o || addressed.includes(o);
}
