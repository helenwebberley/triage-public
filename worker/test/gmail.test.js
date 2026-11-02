import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise } from "../src/gmail.js";
import { render } from "../src/classify.js";

const b64url = (s) => Buffer.from(s).toString("base64url");

test("normalise reads headers, labels and prefers text/plain", () => {
  const m = {
    id: "abc",
    threadId: "t1",
    internalDate: "1792738800000",
    labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"],
    snippet: "snip",
    payload: {
      headers: [
        { name: "From", value: "YouTube Creators <no-reply@youtube.com>" },
        { name: "Subject", value: "Month in review" },
        { name: "List-Unsubscribe", value: "<https://yt.example/u>" },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>html version</p>") } },
        { mimeType: "text/plain", body: { data: b64url("plain version") } },
      ],
    },
  };
  const n = normalise({ id: "clinic", label: "Clinic", email: "h@clinic.example" }, m);
  assert.equal(n.from.addr, "no-reply@youtube.com");
  assert.equal(n.text, "plain version");
  assert.deepEqual(n.gmailLabels, ["CATEGORY_PROMOTIONS"]);
  assert.equal(n.link, "https://mail.google.com/mail/u/h@clinic.example/#all/t1");
  const prompt = render(n);
  assert.match(prompt, /^<email>\nInbox: Clinic/);
  assert.match(prompt, /List-Unsubscribe header: yes/);
  assert.match(prompt, /<\/email>$/);
});
