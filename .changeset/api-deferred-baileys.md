---
"@bot-wa/baileys": minor
---

`BaileysProviderConfig.logger` takes any core `LoggerLike` (pino, `console` or a `{ debug, info, warn, error }` object), not only pino's `Logger`. Baileys' own functions receive a `BaileysLogger` through the new `toBaileysLogger()`: a pino-shaped logger passes through untouched; anything else is wrapped (`trace` forwarded when present, else a no-op; `level` falls back to `'info'`; `child()` wraps `logger.child()` when available). Also exported: `isBaileysLogger()` and the `BaileysLogger` type.
