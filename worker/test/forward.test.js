import { test } from "node:test";
import assert from "node:assert/strict";
import PostalMime from "postal-mime";
import { buildForward, pickSender } from "../src/forward.js";

const pdf = Buffer.from("%PDF-1.4 pretend itinerary").toString("base64");
const original = [
  "From: SAS <noreply@flysas.com>",
  "To: owner@work.example",
  "Subject: Your booking ABC123: Málaga",
  "Date: Fri, 23 Oct 2026 09:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "SK1234 London Heathrow to Málaga, 2 November 2026, 07:40.",
  "--b",
  'Content-Type: application/pdf; name="eticket.pdf"',
  'Content-Disposition: attachment; filename="eticket.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  pdf,
  "--b--",
  "",
].join("\r\n");

test("a forward keeps the text, the original sender and the attachment", async () => {
  const fwd = await buildForward(new TextEncoder().encode(original), { to: "trips@travel.example", received: 0 });
  assert.equal(fwd.files, 1);
  const p = await PostalMime.parse(fwd.mime, { attachmentEncoding: "base64" });
  assert.equal(p.to[0].address, "trips@travel.example");
  assert.equal(p.subject, "Fwd: Your booking ABC123: Málaga");
  assert.match(p.text, /From: SAS <noreply@flysas.com>/);
  assert.match(p.text, /SK1234 London Heathrow to Málaga/);
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].filename, "eticket.pdf");
  assert.equal(p.attachments[0].content.replace(/\s/g, ""), pdf);
});

test("sends from the arrival inbox when the travel desk accepts it, else an allowed one", () => {
  const env = { TRAVEL_FROM: "owner@work.example,owner@gmail.example" };
  const hw = { id: "hw", kind: "gmail", email: "owner@work.example", enc_token: "x" };
  const gm = { id: "gm", kind: "gmail", email: "Owner@gmail.example", enc_token: "x" };
  const clinic = { id: "clinic", kind: "gmail", email: "owner@clinic.example", enc_token: "x" };
  const ic = { id: "ic", kind: "icloud", email: "owner@icloud.example" };
  assert.equal(pickSender(env, gm, [hw, gm, clinic, ic]).id, "gm");
  assert.equal(pickSender(env, clinic, [clinic, gm, hw, ic]).id, "hw");
  assert.equal(pickSender(env, ic, [ic, gm]).id, "gm");
  assert.equal(pickSender(env, ic, [ic, clinic]), null);
  assert.equal(pickSender(env, ic, [ic, { ...hw, enc_token: null }]), null);
});

import { buildReply } from "../src/forward.js";

test("buildReply threads, prefixes Re: once, and blocks header injection", () => {
  const mime = buildReply({
    to: "Agent <agent@x.co.uk>\r\nBcc: evil@x.com",
    subject: "RE: Solicitors",
    body: "Yes, £40,000 is fine.",
    inReplyTo: "<abc@x>",
    references: "<root@x>",
  });
  const head = mime.split("\r\n\r\n")[0];
  assert.match(head, /^To: Agent <agent@x.co.uk> Bcc: evil@x.com$/m);
  assert.ok(!/^Bcc:/m.test(head));
  assert.match(head, /^Subject: RE: Solicitors$/m);
  assert.match(head, /^In-Reply-To: <abc@x>$/m);
  assert.match(head, /^References: <root@x> <abc@x>$/m);
  const body = Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(body, "Yes, £40,000 is fine.");
});
