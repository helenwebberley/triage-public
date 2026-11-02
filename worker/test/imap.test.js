import { test } from "node:test";
import assert from "node:assert/strict";
import { Imap, imapDate, quote } from "../src/imap.js";

// A fake server: replies to each tagged command with canned bytes, in chunks
// small enough to split literals across reads.
function fakeServer(script) {
  const enc = new TextEncoder();
  const written = [];
  let pending = [enc.encode("* OK IMAP ready\r\n")];
  let closed = false;
  const readable = new ReadableStream({
    async pull(c) {
      while (!pending.length) {
        if (closed) return c.close();
        await new Promise((r) => setTimeout(r, 1));
      }
      const chunk = pending.shift();
      for (let i = 0; i < chunk.length; i += 7) c.enqueue(chunk.slice(i, i + 7));
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      const line = new TextDecoder().decode(chunk);
      written.push(line);
      const tag = line.split(" ")[0];
      const verb = line.split(" ").slice(1, 3).join(" ");
      const reply = script(verb, tag);
      pending.push(enc.encode(reply));
    },
  });
  return { readable, writable, written, close: () => (closed = true) };
}

test("search, fetch with a byte-counted literal, move", async () => {
  const body = "From: Shop <deals@shop.com>\r\nSubject: Sale £50 off\r\n\r\nBuy now";
  const bytes = new TextEncoder().encode(body).length; // £ is two bytes
  const server = fakeServer((verb, tag) => {
    if (verb.startsWith("LOGIN")) return `${tag} OK logged in\r\n`;
    if (verb.startsWith("SELECT")) return `* 3 EXISTS\r\n${tag} OK [READ-WRITE] done\r\n`;
    if (verb === "UID SEARCH") return `* SEARCH 41 42\r\n${tag} OK done\r\n`;
    if (verb === "UID FETCH")
      return `* 2 FETCH (UID 42 INTERNALDATE "23-Oct-2026 07:00:00 +0000" BODY[]<0> {${bytes}}\r\n${body})\r\n${tag} OK done\r\n`;
    if (verb === "UID MOVE") return `* OK [COPYUID 1 42 7]\r\n${tag} OK moved\r\n`;
    if (verb.startsWith("LOGOUT")) return `* BYE\r\n${tag} OK bye\r\n`;
    return `${tag} BAD what\r\n`;
  });
  const imap = new Imap(server);
  await imap.greeting();
  await imap.login("helen@icloud.com", 'pa"ss');
  await imap.select("INBOX");
  assert.deepEqual(await imap.searchSince(new Date(Date.UTC(2026, 9, 22))), [41, 42]);
  const [h] = await imap.fetchHeads([42]);
  assert.equal(h.uid, 42);
  assert.equal(h.internalDate, Date.parse("23-Oct-2026 07:00:00 +0000"));
  assert.equal(new TextDecoder().decode(h.raw), body);
  await imap.move([42], "Archive");
  await imap.logout();
  server.close();
  assert.match(server.written[0], /^T1 LOGIN "helen@icloud.com" "pa\\"ss"\r\n$/);
  assert.match(server.written[2], /^T3 UID SEARCH SINCE 22-Oct-2026/);
});

test("a NO on login does not leak the password into the error", async () => {
  const server = fakeServer((verb, tag) => `${tag} NO [AUTHENTICATIONFAILED] bad\r\n`);
  const imap = new Imap(server);
  await imap.greeting();
  await assert.rejects(imap.login("u", "secret-pass"), (e) => !e.message.includes("secret-pass") && /LOGIN failed/.test(e.message));
  server.close();
});

test("helpers", () => {
  assert.equal(imapDate(new Date(Date.UTC(2026, 0, 5))), "5-Jan-2026");
  assert.equal(quote('a\\b"c'), '"a\\\\b\\"c"');
});
