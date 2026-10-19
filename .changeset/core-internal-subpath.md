---
"@bot-wa/core": minor
---

New `@bot-wa/core/internal` subpath for engine internals (`buildMessageContext`, `createControls`, `createPacer`, `runBroadcast`, `runFormStep`, `newFormToken`, `resolveFormMode`, `resolveReplyTyping`, `normalizeTypingConfig`, `typingDuration`, `parseReplyDelay`, `ExternalSendClock`, `MetricsCollector`, `formatUptime`, `TYPING_REFRESH_MS`), with no semver guarantee. The main entry still re-exports the same values, marked `@deprecated`; they will be removed from it in v3. Internally `Bot` is now a facade over smaller modules (no public API change). Fix: `ctx.bot.start()` / `ctx.bot.stop()` called from a plugin now drive the real bot instead of writing the lifecycle flags onto the plugin's scoped object.
