# @bot-wa/postgres-store

> **Experimental — aún no publicado en npm** (experimental, not yet published to npm). A real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`); the `pnpm add` below will work once it is published.

PostgreSQL [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — persistent, shared bot state backed by PostgreSQL (node-postgres, `pg`). Point any number of bot replicas at the same database and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Documents stored as **JSONB**; per-chat logs ordered by a dedicated `timestamp BIGINT` column.
- `getMessagesByChat(chatId, limit)` is a plain `ORDER BY timestamp DESC LIMIT n` (+ reverse) — latest `limit` messages, oldest→newest (same windowing semantics as `@bot-wa/redis-store` / `@bot-wa/sqlite-store`).
- Optional **table prefix**, so apps/bots can share one database.
- `upsertChat` / `upsertContact` shallow-merge **atomically on the server** (`jsonb ||`), so concurrent partial updates from several replicas never drop each other's fields.
- Injectable pool → fully hermetic unit tests (an in-memory `FakePool` ships with the test-suite; no real PostgreSQL needed), plus an opt-in [integration suite](#integration-tests) against a real server.

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
| `maxMessagesPerChat` | `number`          | unbounded                      | Per-chat cap: `saveMessage` prunes the oldest rows (by timestamp) beyond it. Must be a non-negative integer (else `RangeError`). |
| `purgeBatchSize` | `number` | `1000` | Rows deleted per statement by `purgeExpiredUserData`; the purge loops until nothing expired is left, so a large backlog never runs as one long delete. Must be a positive integer (else `RangeError`). |
| `logger`           | `{ error? }`        | —                              | Receives lifecycle errors (e.g. pool end failure) and the connection errors of idle clients of a store-created pool (the pool reconnects on the next query). An injected pool needs its own `pool.on('error', …)`: without one, node-postgres crashes the process when the server drops an idle connection. |

## Schema

| Table | Columns | Contents |
| ----- | ------- | -------- |
| `{prefix}messages` | `id TEXT PK`, `chat_id TEXT`, `timestamp BIGINT`, `msg JSONB` | `StoredMessage` keyed by `messageKey(ref)` (`chatId:id`, escaped) |
| `{prefix}chats` | `id TEXT PK`, `data JSONB` | `StoredChat` |
| `{prefix}contacts` | `id TEXT PK`, `data JSONB` | `StoredContact` |
| `{prefix}checkpoints` | `key TEXT PK`, `cp JSONB` | `FlowCheckpoint` |
| `{prefix}conversations` | `key TEXT PK`, `messages JSONB` | `AIMessage[]` |
| `{prefix}cursors` | `key TEXT PK`, `value TEXT` | delivery cursor (e.g. Telegram `update_id`) |

An index on `(chat_id, timestamp)` backs `getMessagesByChat`. All writes are parameterized `INSERT ... ON CONFLICT ... DO UPDATE` upserts; all DB access goes through a single `query(text, values)` call. Chats and contacts merge in the conflict clause itself — `data = (data - <keys set to undefined>) || patch` — which is the same `{ ...existing, ...patch }` semantics as `MemoryStore`, but atomic.

## Notes

- Designed for **shared state**: multiple bot replicas on one PostgreSQL database get a consistent view of history, checkpoints and cursors.
- Messages, chats, contacts and cursors live forever — delete them explicitly. There is no TTL (unlike `@bot-wa/redis-store`).
- `start()` is idempotent while started; it creates a pool only when none was injected. `stop()` ends only a self-created pool — an injected pool is left open. An own-pool store can be restarted after `stop()` (fresh pool, idempotent schema pass).
- Replicas may boot at the same moment: concurrent `CREATE TABLE IF NOT EXISTS` of the same table can lose a race on PostgreSQL's catalog (`23505` on `pg_type`), and `start()` retries that statement instead of failing.
- `jsonb` cannot hold U+0000 or unpaired UTF-16 surrogates (e.g. text cut in the middle of an emoji). Rather than failing the whole write, those characters are stored as U+FFFD in the JSONB documents (messages, chats, contacts, checkpoints, conversations); everything else round-trips unchanged.
- `ctx.user` values (`{prefix}user_data.value`) are stored **exactly**, with no U+FFFD replacement. The column is `TEXT`, and PostgreSQL `TEXT` rejects a raw NUL byte too (SQLSTATE `22021`), so the value is written as its `JSON.stringify` text: U+0000 and unpaired surrogates always travel as six-character `\u0000`-style escapes (plain ASCII), which `JSON.parse` turns back into the original characters. The round trip is lossless (proved against a real server in `tests/integration.test.ts`).
- Ids and keys (`id`, `chat_id`, `key`, and `user_id` / `namespace` / `key` in `user_data`) are `TEXT` columns stored verbatim: PostgreSQL rejects U+0000 in them (`22021`), so they must not contain it.
- `timestamp` may be any number: the `BIGINT` sort column gets `Math.floor(timestamp)`, while the exact value is kept in the `msg` document. Order among messages with the same (floored) timestamp is not defined.
- `deleteChat` removes the message log and the chat record in **one statement** (a data-modifying CTE), so both commit or neither does.
- `purgeExpiredUserData` deletes `purgeBatchSize` rows per statement (picked by primary key through the expiry index) until nothing expired is left, so a large backlog never runs as one long transaction.
- **Message keys.** `messageKey(ref)` (from `@bot-wa/core`) is `{chatId}:{id}` with `%` and `:` percent-escaped in each part (`%25`, `%3A`), so ids that contain `:` — Twilio's `whatsapp:+1…` chat ids — never collide (`('a:b', 'c')` and `('a', 'b:c')` used to share the key `a:b:c`). Ids without `:` or `%` keep exactly the key earlier versions wrote. Rows written by an earlier version under the old unescaped key are still read and deleted (a fallback that only runs for ids containing `:` or `%`, and only returns or deletes a row whose stored `ref` is that very message, since a legacy key can be another message's new key), and re-saving such a message moves it to the new key — no manual migration. One theoretical edge remains: an id that literally contains `%3A` and was stored by an earlier version can be overwritten by a new message whose id has `:` in the same place.

## Integration tests

Unit tests run against the in-memory `FakePool`, which pattern-matches the statements the store issues, so they cannot prove that PostgreSQL accepts them. `tests/integration.test.ts` runs the shared `IStore` conformance suite plus store-specific checks (idempotent schema, persistence across `stop()`/`start()`, `maxMessagesPerChat` trimming, `deleteChat` purging the log, atomic shallow merge, unicode and multi-MB JSON, ordering/limit, concurrent writes) against a **real** server.

It is opt-in: without `BOTWA_TEST_POSTGRES_URL` the whole file is skipped and `pnpm test` stays hermetic (no network).

```bash
# a throwaway PostgreSQL 16 on port 55432
docker run -d --name botwa-it-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=botwa -p 55432:5432 postgres:16-alpine

BOTWA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/botwa \
  pnpm --filter @bot-wa/postgres-store test

docker rm -f botwa-it-postgres
```

- Use `127.0.0.1` rather than `localhost` on Windows: `localhost` resolves to `::1` first and Docker Desktop's IPv6 port forward can hang until the connection timeout.
- Each run creates its tables under a random prefix (`it<hex>_<n>_…`, one per store) and drops them in `afterAll`, so reruns and parallel CI jobs can share one database. The user in the URL needs `CREATE` on the current schema.
- CI does not run this suite; run it locally with Docker before changing the store.

