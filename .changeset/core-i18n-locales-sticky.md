---
"@bot-wa/core": minor
---

i18n: new `locales` option (`BotConfig.i18n` / `bot.locale({ locales })`), an allow-list of the languages the bot serves. A stored preference, provider-reported or detected language outside it is ignored (resolution falls back to `defaultLocale`, always served) and `ctx.setLang()` refuses it; `'en'` also serves `'en-GB'`. Use `locales: ['en']` to pin a single-language bot so a client in another language does not get built-in texts in its language around your content. Also, an update whose provider reports no language (Telegram's `language_code` is optional) now reuses the last language reported for the same sender (in memory, bounded) instead of flipping the chat to the default between turns.
