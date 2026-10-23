# @botmesh/mysql-store

> [!WARNING]
> **Experimental — not yet published on npm.** The package is `"private": true` inside the monorepo; the API and schema may change without notice. It is tested against a real MySQL (see [Integration tests](#integration-tests)).

MySQL/MariaDB [`IStore`](https://github.com/andresayac/botmesh/tree/main/packages/core) implementation for **@botmesh/core** — persistent, shared bot state backed by [mysql2](https://www.npmjs.com/package/mysql2). Point any number of bot replicas at the same database and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Six small tables, `CREATE TABLE IF NOT EXISTS` on `start()` — no migrations to run by hand. Ids/keys are compared **byte-for-byte** (`VARBINARY`), never through a case- or accent-insensitive collation.
- Message bodies, chats, contacts, checkpoints and conversations stored as **JSON** documents; `getMessagesByChat(limit)` is an `ORDER BY timestamp DESC LIMIT ?` window, returned oldest→newest (same windowing semantics as `@botmesh/sqlite-store` / `@botmesh/redis-store`).
- Configurable **table prefix**, so apps/bots can share one database.
- Injectable pool → fully hermetic tests (an in-memory fake pool ships with the test-suite; no real MySQL needed). The fake mirrors the server where it matters: it rejects escaped unpaired surrogates in JSON (`ER_INVALID_JSON_TEXT`), returns `VARBINARY` columns as `Buffer`s and models connections, transactions and row locks.

## Install

```bash
pnpm add @botmesh/mysql-store
```

Requires a **running MySQL/MariaDB server** reachable from the bot (e.g. `mysql://localhost:3306/botwa` — the database must already exist; the store creates its own tables but not the database).

## Usage with Bot

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { MysqlStore } from '@botmesh/mysql-store'

const store = new MysqlStore({
  uri: process.env.MYSQL_URL,      // default: mysql://localhost:3306/botwa
  tablePrefix: 'mybot_',           // default: '' (optional namespace)
})
await store.start()                // creates the pool + tables (unless a pool was injected)

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo' }),
  store,
})
```

Or with discrete connection options instead of a URI:

```ts
const store = new MysqlStore({
  host: 'db.internal',
  port: 3306,
  user: 'bot',
  password: process.env.MYSQL_PASSWORD,
  database: 'botwa',
})
```

### Injecting an existing pool

Pass an already-created mysql2/promise pool — the store then never creates or closes it, the caller owns the lifecycle (schema provisioning still runs on `start()`):

```ts
import mysql from 'mysql2/promise'

const pool = mysql.createPool(process.env.MYSQL_URL!)
const store = new MysqlStore({ pool })   // no uri needed
```

In tests, inject an in-memory fake instead (see `tests/fakePool.ts` in this package) so the suite runs with no network and no real MySQL:

```ts
const fake = new FakePool()
const store = new MysqlStore({ pool: fake })
await store.start()
```

## Configuration

| Option        | Type               | Default                      | Description |
| ------------- | ------------------ | ---------------------------- | ----------- |
| `uri`         | `string`           | `mysql://localhost:3306/botwa` | MySQL connection URI. Ignored when `pool` is provided; the host/port/... options take precedence over `uri` when any is set. |
| `host`        | `string`           | —                            | Hostname; when set (with `port`/`user`/`password`/`database`) a config object is built instead of using `uri`. |
| `port`        | `number`           | —                            | Port for the config-based connection. |
| `user`        | `string`           | —                            | User for the config-based connection. |
| `password`    | `string`           | —                            | Password for the config-based connection. |
| `database`    | `string`           | —                            | Database for the config-based connection. |
| `tablePrefix` | `string`           | `''`                         | Prefix for every table (`[A-Za-z0-9_]` only). |
| `pool`        | `PoolLike`         | —                            | Inject an existing mysql2/promise pool (required for tests): `query`, `getConnection` and `end`. The store never creates/closes it. |
| `maxMessagesPerChat` | `number`    | — (unbounded)                | Keep at most N messages per chat; `saveMessage` prunes the oldest (by `timestamp`) beyond the cap. Must be a non-negative integer (else `RangeError`). |
| `purgeBatchSize` | `number` | `1000` | Rows deleted per statement by `purgeExpiredUserData`; the purge loops until nothing expired is left, so a large backlog never runs as one long delete. Must be a positive integer (else `RangeError`). |
| `logger`      | `{ error?, warn? }` | —                           | Receives lifecycle errors (e.g. pool close failure) and, through `warn` (else `error`), the legacy-schema notice of `start()`. |

## Schema

Provisioned idempotently on `start()` (`CREATE TABLE IF NOT EXISTS`), with `{p}` = `tablePrefix`:

| Table | Columns | Contents |
| ----- | ------- | -------- |
| `{p}messages` | `id VARBINARY(1024) PRIMARY KEY, chat_id VARBINARY(1024) NOT NULL, timestamp BIGINT, msg JSON`, index `chat_ts (chat_id, timestamp)` | one row per `StoredMessage` (`id` = `messageKey(ref)`, `{chatId}:{id}` escaped) |
| `{p}chats` | `id VARBINARY(1024) PRIMARY KEY, data JSON` | `StoredChat` |
| `{p}contacts` | `id VARBINARY(1024) PRIMARY KEY, data JSON` | `StoredContact` |
| `{p}checkpoints` | `` `key` VARBINARY(1024) PRIMARY KEY, cp JSON `` | `FlowCheckpoint` |
| `{p}conversations` | `` `key` VARBINARY(1024) PRIMARY KEY, messages JSON `` | `AIMessage[]` |
| `{p}cursors` | `` `key` VARBINARY(1024) PRIMARY KEY, value TEXT `` | delivery cursor (e.g. Telegram `update_id`) |

Every table is created `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, regardless of the server defaults. Writes are upserts (`INSERT ... ON DUPLICATE KEY UPDATE`) with fully parameterized statements (`?` placeholders). The `chat_ts` index serves the `getMessagesByChat` window, `deleteChat` and the `maxMessagesPerChat` trim.

Why `VARBINARY` keys: ids are opaque strings and must compare exactly. A `VARCHAR` inherits the server collation — `utf8mb4_0900_ai_ci` on MySQL 8 is case- **and** accent-insensitive, so `abc`/`ABC` or `e`/`é` would share one row — and the `_bin` collations are `PAD SPACE` (`'k' = 'k '`). Keys may be up to 1024 bytes (long base64 message ids, composed checkpoint keys).

### Upgrading tables created by an earlier version

`CREATE TABLE IF NOT EXISTS` never alters existing tables. Tables provisioned before the switch to `VARBINARY` keys keep the old `VARCHAR(255)` columns (collation-dependent comparisons, 255-character limit) and lack the index. `start()` detects them and logs a warning naming the affected columns (the store keeps working). To upgrade them in place (bytes are preserved; replace `{p}` with your prefix):

```sql
ALTER TABLE `{p}messages` MODIFY id VARBINARY(1024) NOT NULL, MODIFY chat_id VARBINARY(1024) NOT NULL, ADD KEY chat_ts (chat_id, timestamp);
ALTER TABLE `{p}chats` MODIFY id VARBINARY(1024) NOT NULL;
ALTER TABLE `{p}contacts` MODIFY id VARBINARY(1024) NOT NULL;
ALTER TABLE `{p}checkpoints` MODIFY `key` VARBINARY(1024) NOT NULL;
ALTER TABLE `{p}conversations` MODIFY `key` VARBINARY(1024) NOT NULL;
ALTER TABLE `{p}cursors` MODIFY `key` VARBINARY(1024) NOT NULL;
```

## Notes

- `getMessagesByChat(chatId, limit)` reads the newest `limit` rows (`ORDER BY timestamp DESC LIMIT ?`) and returns them oldest→newest — same windowing semantics as `@botmesh/sqlite-store`.
- `start()` creates a pool only when none was injected (and is safe to call again); `stop()` closes only a self-created pool. An injected pool is caller-managed and keeps serving after `stop()`.
- MySQL's `JSON` type rejects unpaired UTF-16 surrogates (e.g. a string cut in the middle of an emoji). The store writes them as U+FFFD (`�`) instead of failing the write — the same value the UTF-8 based stores end up with. Well-formed text (emoji, CJK, RTL, combining marks) round-trips unchanged.
- `upsertChat`/`upsertContact` merge shallowly — exactly `{ ...existing, ...patch }` like `MemoryStore` (nested values are replaced, `null` is kept, an explicit `undefined` drops the key) — and **atomically across processes**: each upsert runs a short transaction on a dedicated pool connection (`SELECT data ... FOR UPDATE`, merge, `UPDATE`, `COMMIT`), so concurrent partial upserts of the same record from several replicas never lose fields. A missing row is created first with `INSERT ... ON DUPLICATE KEY UPDATE id = id` (no lock held, so creators never deadlock), and a deadlock victim is retried. `JSON_MERGE_PATCH` is not used on purpose: it merges recursively and treats `null` as delete.
- An injected pool must therefore also provide `getConnection()` (every mysql2/promise pool does); see `PoolLike`/`ConnectionLike`.
- Works against MySQL 5.7+/8.x and MariaDB 10.x (`VALUES(col)` upsert syntax). The integration suite has been run against MySQL 8.4 and 8.0.
- The database named in the URI/config must exist — the store creates tables, not databases.
- `purgeExpiredUserData` deletes `purgeBatchSize` rows per statement (`DELETE … ORDER BY expires_at LIMIT ?`) until nothing expired is left, so a large backlog never holds InnoDB locks for one long delete.
- **Message keys.** `messageKey(ref)` (from `@botmesh/core`) is `{chatId}:{id}` with `%` and `:` percent-escaped in each part (`%25`, `%3A`), so ids that contain `:` — Twilio's `whatsapp:+1…` chat ids — never collide (`('a:b', 'c')` and `('a', 'b:c')` used to share the key `a:b:c`). Ids without `:` or `%` keep exactly the key earlier versions wrote. Rows written by an earlier version under the old unescaped key are still read and deleted (a fallback that only runs for ids containing `:` or `%`, and only returns or deletes a row whose stored `ref` is that very message, since a legacy key can be another message's new key), and re-saving such a message moves it to the new key — no manual migration. One theoretical edge remains: an id that literally contains `%3A` and was stored by an earlier version can be overwritten by a new message whose id has `:` in the same place.

## Durable scheduler

`store.schedules()` returns a `MysqlScheduleStore` on the same pool and `tablePrefix` (table `{tablePrefix}schedules`), for `bot.schedule/every/delay(spec, { id }, fn)` durable tasks shared by any number of replicas:

```ts
const store = new MysqlStore({ uri: process.env.MYSQL_URL })
const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
bot.schedule('0 9 * * 1-5', { id: 'daily-report', timeZone: 'Europe/Madrid' }, async (run) => { /* … */ })
```

- Ids, specs and lease owners are `VARBINARY` (byte-exact, like the store's keys): ids up to 1024 bytes, specs up to 2048, owners up to 512. Longer values fail fast with a `RangeError` instead of looping in the engine's retries.
- A claim runs `START TRANSACTION; SELECT … FOR UPDATE; UPDATE; COMMIT` on a dedicated connection (an equality lock on the primary key, so claimers queue), retries a deadlock victim (errno 1213) up to 3 times and always releases the connection. `renew`/`complete` are single conditional updates fenced by the token; `renew` is correct with or without the `FOUND_ROWS` client flag.
- The scheduler calls its `start()`, which creates the table (`CREATE TABLE IF NOT EXISTS`, InnoDB, utf8mb4). The bot starts the store first; if you use the store only for schedules, `await store.start()` yourself. A standalone `new MysqlScheduleStore({ pool, tablePrefix })` borrows any pool and never closes it.
- `delete()` (`task.cancel()`, `bot.forgetTask(id)`) is a soft delete: the row stays with `deleted = 1` so the id's fencing token never goes backwards. Purge old tombstones by hand only when no runner can still hold their token, e.g. `DELETE FROM schedules WHERE deleted = 1 AND updated_at < <epoch ms a day ago>`.
- Leases use the caller's clock (`now`): keep replicas in sync (NTP).
- `tests/schedules.integration.test.ts` runs the shared `ScheduleStore` conformance suite (also without `FOUND_ROWS`), 20 claimers on two 2-connection pools, a concurrent schema race and a two-bot end-to-end run against a real server (same `BOTWA_TEST_MYSQL_URL`).


## Integration tests

The unit tests (`tests/mysql-store.test.ts`, `tests/conformance.test.ts`) use an in-memory `FakePool` that understands the store's statements, so they never run real SQL. `tests/integration.test.ts` does: it runs the shared `IStore` conformance suite plus MySQL-specific cases (idempotent schema and indexes, persistence across `stop()`/`start()` with a fresh client, `maxMessagesPerChat` trimming, `deleteChat` purging the log, shallow merge, unicode/emoji and large JSON, `getMessagesByChat` order/limit, concurrent `saveMessage`, partial and concurrent `upsertChat`/`upsertContact` from several clients (atomic merge without losing fields) and ids that differ only in case/accents) against a real server.

It is opt-in: it is enabled by the `BOTWA_TEST_MYSQL_URL` environment variable and, when it is not set, the whole suite is skipped, so `pnpm test` stays hermetic. A few "hermetic pins" in the same file lock those regressions without a server and always run.

```bash
# 1. A disposable MySQL (port 53306 so it does not clash with a local one)
docker run -d --name botwa-it-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=botwa -p 53306:3306 mysql:8.4

# 2. Wait until it accepts TCP connections: repeat until you see "mysqld is alive"
#    (the first boot initializes the data and takes about 20-30 s)
docker exec botwa-it-mysql mysqladmin ping -h 127.0.0.1 -uroot -proot

# 3. Run the suite against it
BOTWA_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:53306/botwa pnpm --filter @botmesh/mysql-store test

# 4. Clean up
docker rm -f botwa-it-mysql
```

In PowerShell: `$env:BOTWA_TEST_MYSQL_URL = 'mysql://root:root@127.0.0.1:53306/botwa'; pnpm --filter @botmesh/mysql-store test`.

- **Isolation:** each store in the test uses its own `tablePrefix` (`it<run>_<n>_`); each test drops its tables when it finishes and an `afterAll` removes whatever is left from that run. It can target a shared database without overwriting data or clashing with another parallel run.
- **User:** it needs `CREATE`, `DROP`, `INDEX`, `SELECT`, `INSERT`, `UPDATE` and `DELETE` privileges on the database, plus read access to `information_schema`.
- **Windows + Docker Desktop:** use `127.0.0.1` instead of `localhost`. `localhost` resolves to `::1` first and Docker Desktop's IPv6 forwarding accepts the TCP connection but never delivers the MySQL handshake, so `mysql2` ends in `ETIMEDOUT`.
- **CI:** this suite does not run in CI; run it locally with Docker before touching the store.
