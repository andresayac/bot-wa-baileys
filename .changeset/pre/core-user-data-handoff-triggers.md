---
"@bot-wa/core": minor
---

Add the wave-2 engine features:

- `ctx.user` persistent per-user profiles (dot paths, namespaces, TTL) with `bot.user()`, `userOf()` and `bot.purgeExpiredUserData()`; optional user-data methods on `IStore`; `exportSubject`/`deleteSubject` include `userData`.
- Human handoff (`ctx.handoff()`, `bot.handoff/resume/isHandedOff/getHandoff/listHandoffs`, `bot.sendTo()`, `'handoff'`/`'resume'` events, `BotConfig.handoff`) and dynamic `bot.blacklist` / `bot.whitelist`.
- Special triggers `WELCOME`, `MEDIA`, `IMAGE`, `VIDEO`, `AUDIO`, `VOICE_NOTE`, `DOCUMENT`, `STICKER`, `LOCATION`, `CONTACT`, `POLL`, `CALL`, `typeTrigger()` and `bot.resetWelcome()`; `CallEvent` gains `chatId`, `isGroup`, `isVideo`, `offline`.
- Conversations: `c.retry()`, `c.idle()`/`c.idleClear()`, `bot.onIdle()`/`bot.clearIdle()`, and a fully typed `MessageContext` in `bot.conversation()` handlers.
- Inbound dedupe (`BotConfig.dedupe`, on by default).
- `bot.describe()` / `bot.lint()` (`describeFlows`, `lintFlows`).
- The `bot-wa dev` terminal simulator (`bot-wa` bin, `@bot-wa/core/dev`, `defineBot`, `isMainModule`).
- `@bot-wa/core/testing`: chaos kit (`ChaosProvider`, `withChaos`, `createTestBot(config, { chaos })`) and identity-contract helpers (`assertStableIdentity`, `checkIdentityContract`, `recordEvents`).
