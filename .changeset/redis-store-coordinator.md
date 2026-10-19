---
"@bot-wa/redis-store": minor
---

New `RedisCoordinator` (also `store.coordinator()`), the Redis backend of `BotConfig.coordination`: per-chat ticket FIFO and turn hand-off in Lua (tickets of dead replicas are skipped), `PX`-leased turns and leaderships renewed by a watchdog that gives them up locally before they can expire server-side, and leadership terms as fencing tokens. New `acquireLockFenced(key, ttlMs)` (returns `{ token, fence }`; the fence grows on every acquisition) and `renewLock(key, token, ttlMs)`; `acquireLock` is unchanged and deprecated in their favour.
