---
"@bot-wa/core": minor
---

- Export `loadMediaOf(ctx, { maxBytes, throwOnError })` so plugins can download inbound media before routing. `maxBytes` checks the declared size before downloading and cuts the download once it goes over, rejecting with the new `MediaTooLargeError` (a `PayloadTooLargeError`); `throwOnError` rejects with the download error instead of resolving `undefined`.
- `bot.inspectConversation()` snapshots gain `accepts`: what the pending wait takes (`'text'` for `ask`/`waitText`, the message types of `waitMedia`, `'any'` for `choose`/`waitAny`). New exported type `WaitAccepts`.
- `c.waitMedia()` accepts `'voice'` in its type list (`c.waitMedia(['voice'])`); the default list is unchanged.
