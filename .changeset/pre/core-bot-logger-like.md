---
"@bot-wa/core": patch
---

`BotConfig.logger` now accepts any `LoggerLike`, not just pino: a pino-shaped logger passes through untouched and any other one (`console`, `{ debug, info, warn, error }`) is adapted (`child()` forwards or reuses the logger, `trace`/`fatal` are no-ops). Before, a `LoggerLike` without `child` compiled but threw in the `Bot` constructor. New internal seam `toBotLogger()` (`core/src/core/bot/logger.ts`).
