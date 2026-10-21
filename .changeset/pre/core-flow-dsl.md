---
"@bot-wa/core": minor
---

Flow DSL: `.use(subFlow)` runs a flow inline and returns to the parent with merged state; `choose()` options accept `goto` to leave for another conversation (e.g. back to the main menu); `.guard(check, message | { redirect, message })`; zod-compatible `schema` (any `safeParse()` object) in `.ask()`, `c.ask()` and `c.waitText()`, which resolve with the parsed value; `.media(kind, source, caption?, opts?)` for image/video/audio/voice/document/sticker/location (the legacy `.media(source, caption?)` still sends an image, now compiled as a `media` step); `{ delay }` on say/ask/choose/media plus a `.delay()` step; and typed flow state (`flow<S>()`, `.ask(…, 'key', { schema })` infers `c.state.key`). `bot.describe()` and `bot.lint()` understand the new steps (guard redirects and option gotos are checked like `goto`).
