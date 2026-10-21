---
"@bot-wa/core": minor
"@bot-wa/sqlite-store": minor
"@bot-wa/redis-store": minor
---

Durable scheduler tasks (opt-in). `bot.schedule/every/delay(spec, { id, missed, maxCatchUp, leaseMs }, (run) => ...)` persists the next run in a `ScheduleStore` (`BotConfig.scheduler.store`, in memory by default), applies a missed-run policy (`skip`, `run-once` or `catch-up`) to slots no replica ran in time and claims each occurrence under a fenced lease so replicas never run it concurrently (at least once; `run.occurrenceKey` is an idempotency key). `bot.forgetTask(id)` deletes a stored schedule (orphans, one-shot tombstones); fencing tokens never go backwards for an id, even across deletes. Optional scheduler leadership (`scheduler.lease`, type `SchedulerLease`): a fenced `LeaseProvider` (`MemoryLeaseProvider`, new contract) or the multi-replica `Coordinator`, which a bot with `BotConfig.coordination` uses by default. `@bot-wa/sqlite-store` adds `SQLiteStore#schedules()` (and `SQLiteScheduleStore`, whose constructor takes a structural `SQLiteDatabaseLike`, so consumers need no `@types/better-sqlite3`); `@bot-wa/redis-store` adds `RedisStore#schedules()` and the fenced `RedisStore#leases()`. Tasks without `id` behave as before.
