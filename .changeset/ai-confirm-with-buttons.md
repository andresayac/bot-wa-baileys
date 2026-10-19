---
"@bot-wa/ai": minor
---

`confirmWith(c)` (confirmations inside your own conversation) asks with the same native Yes/No buttons as the autoreply when the channel renders them: typed answers keep working, the press is acknowledged and the buttons are edited away where the provider edits. It sends them to the chat of the `ctx` given to `replyInChat` (new `ToolConfirmRequest.ctx`) or of its new `ctx` option; `buttons: false` keeps the typed question. A press on a confirmation that is no longer pending is now acknowledged and dropped in a `before(message)` hook (also with `autoReply: false`), so it never answers a later question of a conversation. On channels that cannot edit messages (WhatsApp Cloud API, Messenger, Instagram) such a press gets a short localized reply (`ai.tools.confirmExpired`, on by default, `toolConfirm.expiredNotice: false` turns it off; never in a chat handed off to a human); `toolConfirm.answeredNotice` / `confirmWith({ answeredNotice })` (off by default) also acknowledge the pressed answer there (`ai.tools.confirmAnswered`).

Built-in texts for a language without its own catalog (anything but `es` and `en`) now use the bot default locale (`ctx.defaultLang`) when it is `es` or `en`, else English, instead of always Spanish. Without a context they stay in Spanish.
