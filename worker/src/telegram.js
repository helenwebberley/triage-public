// The Telegram bot: the only place anyone sees triage. Plain HTML parse mode,
// link previews off, and no link from an email is ever made clickable, because
// a link in a phishing email is exactly what this must not hand her.

// TELEGRAM_API is only ever set for the local test loop (docs/DEPLOY.md).
const api = (env, method, body) =>
  fetch(`${env.TELEGRAM_API || "https://api.telegram.org"}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const j = await r.json();
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
    return j.result;
  });

// quiet: arrives without a sound or buzz.
export function send(env, chatId, html, buttons, { quiet = false } = {}) {
  return api(env, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    disable_notification: quiet,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export function edit(env, chatId, messageId, html, buttons) {
  return api(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons || [] },
  });
}

export function answer(env, callbackId, text) {
  return api(env, "answerCallbackQuery", { callback_query_id: callbackId, text });
}

// Registers this Worker as the bot's webhook. The secret token makes Telegram
// send a header we check, so nobody else can post fake button taps.
export function setWebhook(env) {
  return api(env, "setWebhook", {
    url: `${env.PUBLIC_URL}/telegram`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
}

export function setCommands(env) {
  return api(env, "setMyCommands", {
    commands: [
      { command: "status", description: "What is connected and when it last checked" },
      { command: "digest", description: "Send the digest now" },
      { command: "mode", description: "watch or act" },
      { command: "connect", description: "Connect a Google inbox: /connect Gmail" },
      { command: "disconnect", description: "Disconnect an inbox and delete what is held for it" },
      { command: "privacy", description: "What is kept, and who can see it" },
      { command: "rules", description: "Your forwarding rules" },
      { command: "cancel", description: "Stop a reply or forward you started" },
      { command: "leave", description: "Disconnect everything and delete it all" },
      { command: "help", description: "What I do" },
    ],
  });
}

// The bot's own username, for building invite links.
export function getMe(env) {
  return api(env, "getMe", {});
}
