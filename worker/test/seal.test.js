import { test } from "node:test";
import assert from "node:assert/strict";
import { userKeys, sealWith, openWith, addrKey } from "../src/seal.js";

const env = { TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") };

test("sealed values round-trip and are unreadable", async () => {
  const k = await userKeys(env, 2);
  const s = await sealWith(k, "Your GP appointment");
  assert.match(s, /^s1:/);
  assert.ok(!s.includes("GP"));
  assert.equal(await openWith(k, s), "Your GP appointment");
});

test("plain legacy values and empties pass through", async () => {
  const k = await userKeys(env, 1);
  assert.equal(await openWith(k, "old subject"), "old subject");
  assert.equal(await sealWith(k, ""), "");
  assert.equal(await sealWith(k, null), null);
});

test("one person's key cannot open another's data", async () => {
  const a = await userKeys(env, 1);
  const b = await userKeys(env, 2);
  await assert.rejects(openWith(b, await sealWith(a, "private")));
});

test("address keys are stable, case-blind and per person", async () => {
  const a = await userKeys(env, 1);
  const b = await userKeys(env, 2);
  assert.equal(await addrKey(a, "X@y.com"), await addrKey(a, "x@y.com"));
  assert.notEqual(await addrKey(a, "x@y.com"), await addrKey(b, "x@y.com"));
});
