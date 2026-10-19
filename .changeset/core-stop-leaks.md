---
"@bot-wa/core": patch
---

`bot.stop()` no longer leaves work or timers behind under load: `stop({ drain: true })` clears its deadline timer when the sends finish early, paced replies still waiting (`BotConfig.typing`, `{ delay }`) are woken and dropped at once, running `ctx.stream()`s are cancelled, a message still queued for a chat is dropped instead of starting a conversation after the stop, and the conversation runtime no longer keeps a shutdown flag per aborted non-persistent conversation. `bot.deleteSubject()` also forgets the language the provider reported for the subject. New `ConversationRuntime.close()`/`open()`/`isClosed()` and `I18n.forget()`.
