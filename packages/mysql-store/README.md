# @bot-wa/mysql-store

MySQL/MariaDB [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — persistent, shared bot state backed by [mysql2](https://www.npmjs.com/package/mysql2). Point any number of bot replicas at the same database and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Six small tables, `CREATE TABLE IF NOT EXISTS` on `start()` — no migrations to run by hand.
- Message bodies, chats, contacts, checkpoints and conversations stored as **JSON** documents; `getMessagesByChat(limit)` is an `ORDER BY timestamp DESC LIMIT ?` window, returned oldest→newest (same windowing semantics as `@bot-wa/sqlite-store` / `@bot-wa/redis-store`).
- Configurable **table prefix**, so apps/bots can share one database.
- Injectable pool → fully hermetic tests (an in-memory fake pool ships with the test-suite; no real MySQL needed).

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
| `pool`        | `PoolLike`         | —                            | Inject an existing mysql2/promise pool (required for tests). The store never creates/closes it. |
| `logger`      | `{ error? }`       | —                            | Receives lifecycle errors (e.g. pool close failure). |

## Schema

Provisioned idempotently on `start()` (`CREATE TABLE IF NOT EXISTS`), with `{p}` = `tablePrefix`:

| Table | Columns | Contents |
| ----- | ------- | -------- |
| `{p}messages` | `id VARCHAR(255) PRIMARY KEY, chat_id VARCHAR(255), timestamp BIGINT, msg JSON` | one row per `StoredMessage` (`id` = `${chatId}:${messageId}`) |
| `{p}chats` | `id VARCHAR(255) PRIMARY KEY, data JSON` | `StoredChat` |
| `{p}contacts` | `id VARCHAR(255) PRIMARY KEY, data JSON` | `StoredContact` |
| `{p}checkpoints` | `` `key` VARCHAR(255) PRIMARY KEY, cp JSON `` | `FlowCheckpoint` |
| `{p}conversations` | `` `key` VARCHAR(255) PRIMARY KEY, messages JSON `` | `AIMessage[]` |
| `{p}cursors` | `` `key` VARCHAR(255) PRIMARY KEY, value TEXT `` | delivery cursor (e.g. Telegram `update_id`) |

Writes are upserts (`INSERT ... ON DUPLICATE KEY UPDATE`) with fully parameterized statements (`?` placeholders). For large message logs, consider adding an index on `({p}messages.chat_id, timestamp)`.

## Notes

- `getMessagesByChat(chatId, limit)` reads the newest `limit` rows (`ORDER BY timestamp DESC LIMIT ?`) and returns them oldest→newest — same windowing semantics as `@bot-wa/sqlite-store`.
- `start()` creates a pool only when none was injected (and is safe to call again); `stop()` closes only a self-created pool. An injected pool is caller-managed and keeps serving after `stop()`.
- Works against MySQL 5.7+/8.x and MariaDB 10.x (`VALUES(col)` upsert syntax).
- The database named in the URI/config must exist — the store creates tables, not databases.
