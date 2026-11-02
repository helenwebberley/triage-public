// Seals Google refresh tokens before they touch D1. The key is the TOKEN_KEY
// Worker secret (32 random bytes, base64). Lose the key and every inbox simply
// needs reconnecting: nothing else depends on it.

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env) {
  return crypto.subtle.importKey("raw", unb64(env.TOKEN_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function unseal(env, sealed) {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

export function randomToken(bytes = 24) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}

// ---------- per-person sealing (docs/DECISIONS.md 14) ----------
//
// Everything that says something about a person's mail (who wrote, the subject,
// the summary, their inbox address and name for it) is sealed before it reaches
// D1, under a key derived for that person alone. Browsing the database shows
// nothing readable. The keys come from TOKEN_KEY and exist only inside the
// running Worker.
//
// Sealed values carry an "s1:" prefix. Anything without it is read back as it
// is, which is how Helen's rows from before sealing still read.

const enc = (s) => new TextEncoder().encode(s);

export async function userKeys(env, userId) {
  const base = await crypto.subtle.importKey("raw", unb64(env.TOKEN_KEY), "HKDF", false, ["deriveKey"]);
  const params = (use) => ({ name: "HKDF", hash: "SHA-256", salt: enc("triage-user-data"), info: enc(`${use}:${userId}`) });
  return {
    enc: await crypto.subtle.deriveKey(params("enc"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    mac: await crypto.subtle.deriveKey(params("mac"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]),
  };
}

export async function sealWith(keys, plain) {
  if (plain === null || plain === undefined || plain === "") return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.enc, enc(String(plain)));
  return `s1:${b64(iv)}.${b64(ct)}`;
}

export async function openWith(keys, value) {
  if (typeof value !== "string" || !value.startsWith("s1:")) return value;
  const [iv, ct] = value.slice(3).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, keys.enc, unb64(ct));
  return new TextDecoder().decode(pt);
}

// A stable lookup key for a sender address, so rules can be found without the
// address itself being stored readable. Keyed, so it cannot be guessed back.
export async function addrKey(keys, addr) {
  const sig = await crypto.subtle.sign("HMAC", keys.mac, enc(String(addr || "").toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Opens the named fields of a row in place and returns it.
export async function openRow(keys, row, fields) {
  if (!row) return row;
  for (const f of fields) row[f] = await openWith(keys, row[f]);
  return row;
}
