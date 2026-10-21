---
"@bot-wa/redis-store": patch
---

Real-server fixes: an unhandled client `'error'` no longer crashes the process on disconnect, `start()`/`stop()` no longer hang, trimming no longer over-prunes under concurrency, `KEYS` patterns are escaped, `limit`/`ttl`/cap values are normalised or validated, and same-key upserts are serialised in-process.
