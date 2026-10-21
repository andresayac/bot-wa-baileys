---
"@bot-wa/telegram": minor
---

`TelegramProviderConfig.logger` takes any core `LoggerLike` (pino, `console` or a `{ debug, info, warn, error }` object), not only pino's `Logger`.
