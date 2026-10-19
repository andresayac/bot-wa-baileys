---
"@bot-wa/core": minor
"@bot-wa/sqlite-store": minor
"@bot-wa/redis-store": minor
---

Durable scheduler tasks (opt-in). `bot.schedule/every/delay(spec, { id, missed, maxCatchUp, leaseMs }, (run) => ...)` persists the next run in a `ScheduleStore` (`BotConfig.scheduler.store`, in memory by default), applies a missed-run policy at start (`skip`, `run-once` or `catch-up`) and claims each occurrence under a fenced lease so one replica runs it (at least once; `run.occurrenceKey` is an idempotency key). New `LeaseProvider` contract for optional scheduler leadership. `@bot-wa/sqlite-store` adds `SQLiteStore#schedules()`; `@bot-wa/redis-store` adds `RedisStore#schedules()` and the fenced `RedisStore#leases()`. Tasks without `id` behave as before.
