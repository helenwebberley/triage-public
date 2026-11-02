import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrom, parseListUnsubscribe, isOneClick, parseMailto, htmlToText, esc, isCopyOf } from "../src/mail.js";

test("parseFrom handles named, quoted and bare addresses", () => {
  assert.deepEqual(parseFrom("Stripe <NoReply@stripe.com>"), { name: "Stripe", addr: "noreply@stripe.com" });
  assert.deepEqual(parseFrom('"YouTube Creators" <no-reply@youtube.com>'), { name: "YouTube Creators", addr: "no-reply@youtube.com" });
  assert.deepEqual(parseFrom("owner@work.example"), { name: "", addr: "owner@work.example" });
});

test("List-Unsubscribe parsing picks https and mailto", () => {
  const h = "<mailto:unsub@list.example.com?subject=stop>, <https://example.com/u?id=1>";
  assert.deepEqual(parseListUnsubscribe(h), { https: "https://example.com/u?id=1", mailto: "mailto:unsub@list.example.com?subject=stop" });
  assert.deepEqual(parseListUnsubscribe(""), { https: null, mailto: null });
});

test("one-click needs both the Post header and an https URL", () => {
  const h = "<https://example.com/u>";
  assert.equal(isOneClick(h, "List-Unsubscribe=One-Click"), true);
  assert.equal(isOneClick(h, ""), false);
  assert.equal(isOneClick("<mailto:a@b.com>", "List-Unsubscribe=One-Click"), false);
});

test("mailto parsing", () => {
  assert.deepEqual(parseMailto("mailto:u@x.com?subject=Remove%20me"), { to: "u@x.com", subject: "Remove me", body: "unsubscribe" });
});

test("htmlToText drops markup and scripts", () => {
  assert.equal(htmlToText("<style>x{}</style><p>Hi&nbsp;Helen</p><script>evil()</script><p>Bye</p>"), "Hi Helen\n Bye");
});

test("esc escapes Telegram HTML", () => {
  assert.equal(esc("<b>&"), "&lt;b&gt;&amp;");
});

test("isCopyOf: someone else's mail only when the owner is not addressed", () => {
  const mine = ["owner@gmail.example", "owner@work.example"];
  const other = "sam@family.example";
  const m = (from, to, cc = "") => ({ from: { addr: from }, to, cc });
  assert.equal(isCopyOf(m("inquiries@ugaresorts.com", "Sam Example <Sam@family.example>"), other, mine), true);
  assert.equal(isCopyOf(m(other, "reservations@hotel.lk"), other, mine), true);
  assert.equal(isCopyOf(m(other, "Helen <owner@gmail.example>"), other, mine), false);
  assert.equal(isCopyOf(m("hotel@x.com", other, "owner@work.example"), other, mine), false);
  assert.equal(isCopyOf(m("shop@x.com", "owner@gmail.example"), other, mine), false);
  assert.equal(isCopyOf(m(other, "x@y.com"), "", mine), false);
});
