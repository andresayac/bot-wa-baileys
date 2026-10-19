# @bot-wa/mysql-store

> [!WARNING]
> **Experimental — aún no publicado en npm.** El paquete es `"private": true` dentro del monorepo; la API y el esquema pueden cambiar sin aviso. Está probado contra un MySQL real (ver [Tests de integración](#tests-de-integración)).

MySQL/MariaDB [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — persistent, shared bot state backed by [mysql2](https://www.npmjs.com/package/mysql2). Point any number of bot replicas at the same database and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Six small tables, `CREATE TABLE IF NOT EXISTS` on `start()` — no migrations to run by hand. Ids/keys are compared **byte-for-byte** (`VARBINARY`), never through a case- or accent-insensitive collation.
- Message bodies, chats, contacts, checkpoints and conversations stored as **JSON** documents; `getMessagesByChat(limit)` is an `ORDER BY timestamp DESC LIMIT ?` window, returned oldest→newest (same windowing semantics as `@bot-wa/sqlite-store` / `@bot-wa/redis-store`).
- Configurable **table prefix**, so apps/bots can share one database.
- Injectable pool → fully hermetic tests (an in-memory fake pool ships with the test-suite; no real MySQL needed). The fake mirrors the server where it matters: it rejects escaped unpaired surrogates in JSON (`ER_INVALID_JSON_TEXT`), returns `VARBINARY` columns as `Buffer`s and models connections, transactions and row locks.

## Install

```bash
pnpm add @bot-wa/mysql-store
```

Requires a **running MySQL/MariaDB server** reachable from the bot (e.g. `mysql://localhost:3306/botwa` — the database must already exist; the store creates its own tables but not the database).

## Usage with Bot

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { MysqlStore } from '@bot-wa/mysql-store'

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

- `getMessagesByChat(chatId, limit)` reads the newest `limit` rows (`ORDER BY timestamp DESC LIMIT ?`) and returns them oldest→newest — same windowing semantics as `@bot-wa/sqlite-store`.
- `start()` creates a pool only when none was injected (and is safe to call again); `stop()` closes only a self-created pool. An injected pool is caller-managed and keeps serving after `stop()`.
- MySQL's `JSON` type rejects unpaired UTF-16 surrogates (e.g. a string cut in the middle of an emoji). The store writes them as U+FFFD (`�`) instead of failing the write — the same value the UTF-8 based stores end up with. Well-formed text (emoji, CJK, RTL, combining marks) round-trips unchanged.
- `upsertChat`/`upsertContact` merge shallowly — exactly `{ ...existing, ...patch }` like `MemoryStore` (nested values are replaced, `null` is kept, an explicit `undefined` drops the key) — and **atomically across processes**: each upsert runs a short transaction on a dedicated pool connection (`SELECT data ... FOR UPDATE`, merge, `UPDATE`, `COMMIT`), so concurrent partial upserts of the same record from several replicas never lose fields. A missing row is created first with `INSERT ... ON DUPLICATE KEY UPDATE id = id` (no lock held, so creators never deadlock), and a deadlock victim is retried. `JSON_MERGE_PATCH` is not used on purpose: it merges recursively and treats `null` as delete.
- An injected pool must therefore also provide `getConnection()` (every mysql2/promise pool does); see `PoolLike`/`ConnectionLike`.
- Works against MySQL 5.7+/8.x and MariaDB 10.x (`VALUES(col)` upsert syntax). The integration suite has been run against MySQL 8.4 and 8.0.
- The database named in the URI/config must exist — the store creates tables, not databases.
- `purgeExpiredUserData` deletes `purgeBatchSize` rows per statement (`DELETE … ORDER BY expires_at LIMIT ?`) until nothing expired is left, so a large backlog never holds InnoDB locks for one long delete.
- **Message keys.** `messageKey(ref)` (from `@bot-wa/core`) is `{chatId}:{id}` with `%` and `:` percent-escaped in each part (`%25`, `%3A`), so ids that contain `:` — Twilio's `whatsapp:+1…` chat ids — never collide (`('a:b', 'c')` and `('a', 'b:c')` used to share the key `a:b:c`). Ids without `:` or `%` keep exactly the key earlier versions wrote. Rows written by an earlier version under the old unescaped key are still read and deleted (a fallback that only runs for ids containing `:` or `%`, and only returns a row that belongs to that chat), and re-saving such a message moves it to the new key — no manual migration. One theoretical edge remains: an id that literally contains `%3A` and was stored by an earlier version can be overwritten by a new message whose id has `:` in the same place.

## Tests de integración

Los tests unitarios (`tests/mysql-store.test.ts`, `tests/conformance.test.ts`) usan un `FakePool` en memoria que reconoce las sentencias del store, así que nunca ejecutan SQL real. `tests/integration.test.ts` sí lo hace: corre la suite compartida de conformidad de `IStore` y casos propios de MySQL (esquema e índice idempotentes, persistencia tras `stop()`/`start()` con un cliente nuevo, recorte con `maxMessagesPerChat`, `deleteChat` purgando el log, merge superficial, unicode/emoji y JSON grandes, orden/límite de `getMessagesByChat`, `saveMessage` concurrentes, `upsertChat`/`upsertContact` parciales y concurrentes desde varios clientes (merge atómico sin pérdida de campos) e ids que solo difieren en mayúsculas/acentos) contra un servidor de verdad.

Es opt-in: se activa con la variable de entorno `BOTWA_TEST_MYSQL_URL` y, si no está definida, se salta entera, así que `pnpm test` sigue siendo hermético. Unos pocos tests "hermetic pins" del mismo archivo fijan esas regresiones sin servidor y corren siempre.

```bash
# 1. Un MySQL desechable (puerto 53306 para no chocar con uno local)
docker run -d --name botwa-it-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=botwa -p 53306:3306 mysql:8.4

# 2. Espera a que acepte conexiones TCP: repite hasta ver "mysqld is alive"
#    (el primer arranque inicializa los datos y tarda unos 20-30 s)
docker exec botwa-it-mysql mysqladmin ping -h 127.0.0.1 -uroot -proot

# 3. Ejecuta la suite contra él
BOTWA_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:53306/botwa pnpm --filter @bot-wa/mysql-store test

# 4. Limpieza
docker rm -f botwa-it-mysql
```

En PowerShell: `$env:BOTWA_TEST_MYSQL_URL = 'mysql://root:root@127.0.0.1:53306/botwa'; pnpm --filter @bot-wa/mysql-store test`.

- **Aislamiento:** cada store del test usa su propio `tablePrefix` (`it<run>_<n>_`); cada test borra sus tablas al terminar y un `afterAll` elimina lo que quede de esa ejecución. Se puede apuntar a una base compartida sin pisar datos ni chocar con otra ejecución en paralelo.
- **Usuario:** necesita permisos de `CREATE`, `DROP`, `INDEX`, `SELECT`, `INSERT`, `UPDATE` y `DELETE` sobre la base, y lectura de `information_schema`.
- **Windows + Docker Desktop:** usa `127.0.0.1` en lugar de `localhost`. `localhost` resuelve primero a `::1` y el reenvío IPv6 de Docker Desktop acepta la conexión TCP pero no entrega el handshake de MySQL, así que `mysql2` acaba en `ETIMEDOUT`.
- **CI:** esta suite no corre en CI; ejecútala en local con Docker antes de tocar el store.
