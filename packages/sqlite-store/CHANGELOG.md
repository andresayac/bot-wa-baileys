# @bot-wa/sqlite-store

## 0.2.0-alpha.0

### Minor Changes

- b95b523: Implement the optional `IStore.setCheckpointIf` / `clearCheckpointIf` compare-and-set checkpoint writes (one atomic statement), used by `ConversationRuntime` with `coordination`.
- 5196990: Durable scheduler tasks (opt-in). `bot.schedule/every/delay(spec, { id, missed, maxCatchUp, leaseMs }, (run) => ...)` persists the next run in a `ScheduleStore` (`BotConfig.scheduler.store`, in memory by default), applies a missed-run policy (`skip`, `run-once` or `catch-up`) to slots no replica ran in time and claims each occurrence under a fenced lease so replicas never run it concurrently (at least once; `run.occurrenceKey` is an idempotency key). `bot.forgetTask(id)` deletes a stored schedule (orphans, one-shot tombstones); fencing tokens never go backwards for an id, even across deletes. Optional scheduler leadership (`scheduler.lease`, type `SchedulerLease`): a fenced `LeaseProvider` (`MemoryLeaseProvider`, new contract) or the multi-replica `Coordinator`, which a bot with `BotConfig.coordination` uses by default. `@bot-wa/sqlite-store` adds `SQLiteStore#schedules()` (and `SQLiteScheduleStore`, whose constructor takes a structural `SQLiteDatabaseLike`, so consumers need no `@types/better-sqlite3`); `@bot-wa/redis-store` adds `RedisStore#schedules()` and the fenced `RedisStore#leases()`. Tasks without `id` behave as before.
- 9bb875e: `SQLiteDurableKv` and `SQLiteDurability`: core's `DurableKv` and durability backend (`BotConfig.durability`) on SQLite, in one table `durable` whose every write is a single statement conditioned on the stored version (atomic compare-and-set across processes on one file). `store.durability()` returns the backend on the store's own connection (`new Bot({ store, durability: { journal: store.durability() } })`); its `kv` is also what the product packages (`@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/campaigns`, `@bot-wa/deployments`, `@bot-wa/hub`) persist to. Opt-in: nothing changes for existing stores until it is called.
- 2c4f9f0: `messageKey(ref)` percent-escapes `%` and `:` in the chat id and the message id, so ids that contain `:` (Twilio's `whatsapp:+1…` chat ids) no longer collide; keys of ids without `:` or `%` are unchanged. New `legacyMessageKey(ref)` returns the old unescaped key. SQLite and Redis stores write the new key, still read and delete rows stored under the legacy key (checking the stored `ref` is the requested message, since a legacy key can be another message's new key), and drop the legacy copy when a message is saved again — no manual migration.
- 1a81406: New `purgeBatchSize` option (default `1000`): `purgeExpiredUserData` deletes expired `ctx.user` rows in batches and yields to the event loop between them, instead of one unbounded `DELETE`.
- 522bcca: Implement the `ctx.user` storage methods (`getUserData`, `setUserData`, `deleteUserData`, `listUserData`, `purgeExpiredUserData`). SQLite adds a `user_data` table with an expiry index; Redis stores one `{prefix}:ud:…` key per entry with native `PX` expiry.

### Patch Changes

- ce7790f: Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
- 3060501: `upsertChat`/`upsertContact` are atomic (read and write in one `IMMEDIATE` transaction), so concurrent partial upserts of one record no longer drop each other's fields. Aligned with `MemoryStore`: messages without `ref.id` or `chatId` are ignored, `getMessagesByChat` normalises `limit` (non-positive → none, fraction → rounded up, `Infinity` or any huge number → all; a negative limit used to return everything), `setUserData` rejects a non-JSON value with a `TypeError`, and an invalid `maxMessagesPerChat` throws a `RangeError`. Statements are prepared once per store.
- Updated dependencies [2e16743]
- Updated dependencies [397c2be]
- Updated dependencies [0a2291f]
- Updated dependencies [ddfb1e9]
- Updated dependencies [ee5777c]
- Updated dependencies [522bcca]
- Updated dependencies [588fa34]
- Updated dependencies [a33cb08]
- Updated dependencies [909fa96]
- Updated dependencies [9cb6621]
- Updated dependencies [99251ef]
- Updated dependencies [7cc66b2]
- Updated dependencies [39a8149]
- Updated dependencies [31fcc2e]
- Updated dependencies [40fdab4]
- Updated dependencies [4bbd0ad]
- Updated dependencies [f8c1d4f]
- Updated dependencies [231cbd2]
- Updated dependencies [ca25eb7]
- Updated dependencies [18958c6]
- Updated dependencies [40ec0bd]
- Updated dependencies [fd07c8c]
- Updated dependencies [0149d66]
- Updated dependencies [9c94d93]
- Updated dependencies [08a933f]
- Updated dependencies [1a81406]
- Updated dependencies [64fb59f]
- Updated dependencies [2549ffe]
- Updated dependencies [a4e9429]
- Updated dependencies [310db8d]
- Updated dependencies [2bab262]
- Updated dependencies [6ea4442]
- Updated dependencies [136caa5]
- Updated dependencies [634993f]
- Updated dependencies [b866fbd]
- Updated dependencies [c6a4292]
- Updated dependencies [7b00477]
- Updated dependencies [6504335]
- Updated dependencies [ce42173]
- Updated dependencies [1984f6f]
- Updated dependencies [522bcca]
- Updated dependencies [02a21cc]
- Updated dependencies [23371fb]
- Updated dependencies [9b97391]
- Updated dependencies [f25b2af]
- Updated dependencies [2232f88]
- Updated dependencies [27620ef]
- Updated dependencies [e4574e6]
- Updated dependencies [ce7790f]
- Updated dependencies [b95b523]
- Updated dependencies [5196990]
- Updated dependencies [2c4f9f0]
- Updated dependencies [efb1fa6]
- Updated dependencies [4fc0560]
  - @bot-wa/core@2.0.0-alpha.2
