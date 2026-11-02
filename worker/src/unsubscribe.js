// Unsubscribing, in order of how safe it is to do without a human:
//
// 1. RFC 8058 one-click: a POST the sender has promised means "unsubscribe" and
//    nothing else. Fully automatic.
// 2. mailto: an email to the address the sender gave. Sent from the inbox the
//    newsletter arrived in. Gmail inboxes only: iCloud has no send path here.
// 3. A plain https link: a web page, which may want clicks, a login, or may be a
//    tracker. Never fetched by code. Helen gets the link to open herself.
//
// Mail in actual junk is never unsubscribed from at all: replying to a spammer
// tells them the address is live. index.js only offers this for newsletters.

import { parseListUnsubscribe, isOneClick, parseMailto } from "./mail.js";

export async function unsubscribe(sender, inbox) {
  const { https, mailto } = parseListUnsubscribe(sender.unsub);

  // Each route that fails falls through to the next, ending with the link.
  if (isOneClick(sender.unsub, sender.unsub_post)) {
    try {
      const r = await fetch(https, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        redirect: "manual",
      });
      if (r.status < 400) return { done: true, how: "one-click" };
    } catch {
      // their server is down or refused us
    }
  }

  if (mailto && inbox?.send) {
    try {
      await inbox.send(parseMailto(mailto));
      return { done: true, how: "email" };
    } catch {
      // fall through
    }
  }

  if (https) return { done: false, how: "link", url: https };
  return { done: false, how: "none" };
}
