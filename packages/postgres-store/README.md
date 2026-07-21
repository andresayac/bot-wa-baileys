# @bot-wa/postgres-store

PostgreSQL [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — persistent, shared bot state backed by PostgreSQL (node-postgres, `pg`). Point any number of bot replicas at the same database and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Documents stored as **JSONB**; per-chat logs ordered by a dedicated `timestamp BIGINT` column.
- `getMessagesByChat(chatId, limit)` is a plain `ORDER BY timestamp DESC LIMIT n` (+ reverse) — latest `limit` messages, oldest→newest (same windowing semantics as `@bot-wa/redis-store` / `@bot-wa/sqlite-store`).
- Optional **table prefix**, so apps/bots can share one database.
- Injectable pool → fully hermetic tests (an in-memory `FakePool` ships with the test-suite; no real PostgreSQL needed).

## Install

```bash
pnpm add @bot-wa/postgres-store pg
```

**Requires a running PostgreSQL server** reachable from the bot (e.g. `postgres://localhost:5432/botwa`). The store creates its tables automatically on `start()` (`CREATE TABLE IF NOT EXISTS`, safe across replicas and restarts).

## Usage with Bot

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { PostgresStore } from '@bot-wa/postgres-store'

const store = new PostgresStore({
  connectionString: process.env.DATABASE_URL, // default: postgres://localhost:5432/botwa
  tablePrefix: 'mybot_',                      // default: ''
})
await store.start() // creates the pool (unless one was injected) + schema

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo' }),
  store,
})
```

### Injecting an existing pool

Pass an already-created `pg` `Pool` — the store then never creates or ends it, the caller owns the lifecycle:

```ts
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = new PostgresStore({ pool }) // no connectionString needed
await store.start()                       // still (idempotently) creates the schema
```

In tests, inject an in-memory fake instead (see `tests/fakePool.ts` in this package) so the suite runs with no network and no real PostgreSQL:

```ts
const fake = new FakePool()
const store = new PostgresStore({ pool: fake })
await store.start()
```

## Configuration

| Option             | Type                | Default                        | Description |
| ------------------ | ------------------- | ------------------------------ | ----------- |
| `connectionString` | `string`            | `postgres://localhost:5432/botwa` | PostgreSQL connection URL. Ignored when `pool` is provided. |
| `tablePrefix`      | `string`            | `''`                           | Identifier prefix for every table (`'mybot_'` → `mybot_messages`). Plain identifier characters only. |
| `pool`             | `PostgresPoolLike`  | —                              | Inject an existing `pg` `Pool`-like client (required for tests). The store never creates/ends it. |
| `logger`           | `{ error? }`        | —                              | Receives lifecycle errors (e.g. pool end failure). |

## Schema

| Table | Columns | Contents |
| ----- | ------- | -------- |
| `{prefix}messages` | `id TEXT PK`, `chat_id TEXT`, `timestamp BIGINT`, `msg JSONB` | `StoredMessage` keyed by `messageKey(ref)` (`chatId:id`) |
| `{prefix}chats` | `id TEXT PK`, `data JSONB` | `StoredChat` |
| `{prefix}contacts` | `id TEXT PK`, `data JSONB` | `StoredContact` |
| `{prefix}checkpoints` | `key TEXT PK`, `cp JSONB` | `FlowCheckpoint` |
| `{prefix}conversations` | `key TEXT PK`, `messages JSONB` | `AIMessage[]` |
| `{prefix}cursors` | `key TEXT PK`, `value TEXT` | delivery cursor (e.g. Telegram `update_id`) |

An index on `(chat_id, timestamp)` backs `getMessagesByChat`. All writes are parameterized `INSERT ... ON CONFLICT ... DO UPDATE` upserts; all DB access goes through a single `query(text, values)` call.

## Notes

- Designed for **shared state**: multiple bot replicas on one PostgreSQL database get a consistent view of history, checkpoints and cursors.
- Messages, chats, contacts and cursors live forever — delete them explicitly. There is no TTL (unlike `@bot-wa/redis-store`).
- `start()` is idempotent while started; it creates a pool only when none was injected. `stop()` ends only a self-created pool — an injected pool is left open. An own-pool store can be restarted after `stop()` (fresh pool, idempotent schema pass).
- Message IDs are `messageKey(ref)` = `` `${ref.chatId}:${ref.id}` `` (imported from `@bot-wa/core`), so message ids that are only unique per chat on some transports are safe.
