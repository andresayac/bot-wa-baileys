---
"@bot-wa/core": minor
---

Public API coherence (see `docs/api-review.md`), all backwards compatible:

- Export types that public signatures already referenced: `InboundListener`, `StopOptions`, `ConversationTarget`, `WaitMediaType`, `UserDataStore`, `PacerLogger`, `FormFieldBase`, `JsonValue` (main entry; it was only in `/testing`), and `MockIncomingOptions` from `@bot-wa/core/testing`.
- One duration grammar everywhere: the internal parser (flows, reply delays, broadcast, dedupe, conversations) now accepts what the exported `parseDuration` did (`'1d'`, `'1w'`, `'5 minutes'`, digit strings).
- `bot.stop({ timeout })` and `MemoryStore({ autoSaveInterval })` also accept a duration string; `bot.send()` accepts a plain string like `sendTo()`/`broadcast()`; `bot.onError()` takes an optional `priority` like `before()`/`after()`.
- Fix: `bot.hook()` called from a plugin is now removed by `unplug()`, and `onError` inside a plugin honours its priority.
- `ConversationError` and `ProviderError` subclasses carry their class `name`.
- `HookEvent` keeps editor autocomplete for the built-in event names.
- Deprecate `ctx.replyWithTyping()` in favour of `ctx.reply(text, { typing: true })`.
