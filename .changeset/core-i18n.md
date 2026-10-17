---
"@bot-wa/core": minor
---

Native i18n: `bot.locale(code, messages)` / `bot.locale(options)` registry with nested keys, `{param}` interpolation and plural forms; `ctx.t()`, `ctx.lang`, `ctx.setLang()` (persisted to `ctx.user`; only accepts a code a registered locale serves and rejects while i18n is off), `c.t()` / `c.lang` in conversations, `bot.t()` / `bot.langOf()`. Language resolution (each candidate must be served by a registered locale): `ctx.user` preference → provider-reported language (`SenderInfo.language` or `platformData.languageCode`) → `i18n.detect` → default. Built-in core messages (timeouts, retries, errors, wait validation, slash commands) are localizable under `core.*` with `es` and `en` defaults; without any i18n configuration bots keep their Spanish defaults.
