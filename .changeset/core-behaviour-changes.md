---
"@bot-wa/core": minor
---

Behaviour changes:

- Handler errors always reach the bot `'error'` event, even without an `onError('message')` hook.
- Inbound dedupe is on by default: a redelivered message with the same `chatId` + id and body is handled once (`dedupe: false` opts out).
- `slashCommandsPlugin`: `/reset` also re-arms `WELCOME`; `/cancel` only cancels.
- `bot.onType()` / `bot.onImage()`… move to specificity tier 2 (same relative order; multi-type triggers sit at 1).
- `MessageContext` gains the required `user` and `handoff()` members and the optional `call`.
- `deleteSubject()` also forgets the subject chat's handoff and re-arms its `WELCOME`.
