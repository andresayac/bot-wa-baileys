# Persistent Store

The **store** is where the bot keeps messages, chats, contacts, flow state, checkpoints and AI conversation history. Choosing the right store is the difference between a bot that forgets everything on restart and one that survives deploys.

Stores implement the generic, transport-neutral `IStore` from `@bot-wa/core` — the same store works with any provider (Baileys, Cloud API, Telegram, Discord).

## Available stores

| Store | Package | Persistence | Use case |
|---|---|---|---|
| `MemoryStore` *(default)* | `@bot-wa/core` | In-memory (optional JSON dump) | Development, tests, short-lived bots |
| `SQLiteStore` | `@bot-wa/sqlite-store` | SQLite file (WAL mode) | **Production** — single-bot, zero-config |
| `RedisStore` | `@bot-wa/redis-store` | Redis server | Distributed state, multiple instances, TTL |
| `MongoStore` · `PostgresStore` · `MysqlStore` | `@bot-wa/mongo-store` · `@bot-wa/postgres-store` · `@bot-wa/mysql-store` | MongoDB / PostgreSQL / MySQL | **Experimental** — real, tested implementations, not published yet |

`MemoryStore` ships with the core. `SQLiteStore` and `RedisStore` are part of
the first alpha (not on npm yet — the first publish is being prepared). The
MongoDB, PostgreSQL and MySQL stores pass the same `IStore` conformance
suite but stay private (unpublished) for now; see their READMEs in the
[repository](https://github.com/andresayac/bot-wa-baileys/tree/main/packages).

## MemoryStore (default)

If you don't pass a `store`, the bot creates a `MemoryStore`. Everything lives in RAM; an optional JSON file can snapshot chats/contacts/checkpoints (not messages) on an interval.

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  // Optional: persist chats + flow state to a JSON file
  storeConfig: {
    file: './store.json',
    autoSaveInterval: 60_000, // ms (0 = disable)
    maxMessagesPerChat: 1000,
  },
})
```

::: warning Messages are NOT restored
`MemoryStore` intentionally skips messages on reload (privacy + size). Only chats, contacts, flow states, checkpoints and AI conversations survive a restart via the JSON dump.
:::

## SQLiteStore (recommended for production)

A real database backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — synchronous, zero-config, single-file. Perfect for a single bot instance on a VPS or Docker container. It's a **separate package**; `better-sqlite3` is a peer dependency you install next to it (it is loaded when the store is constructed, so a missing install fails with a clear error):

```bash
pnpm add @bot-wa/sqlite-store better-sqlite3
```

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `file` | `string` | `'./bot.db'` | Path to the SQLite database file |
| `wal` | `boolean` | `true` | Enable WAL mode (better concurrent reads) |
| `maxMessagesPerChat` | `number` | — (unbounded) | Keep only the newest N messages per chat; older rows are pruned on save |
| `logger` | `object` | — | Logger for errors (`{ error: fn }`) |

### What it stores

| Table | Content |
|---|---|
| `messages` | Every inbound/outbound message (keyed by chat + timestamp) |
| `chats` | Chat metadata (name, kind, etc.) |
| `contacts` | Contact info (display name, username, etc.) |
| `checkpoints` | `persistent()` flow checkpoints, including the flow's `c.state` — survive restarts |
| `conversations` | AI conversation history (`@bot-wa/ai`) |
| `cursors` | Delivery cursors (e.g. Telegram's `update_id`) |

### Schema

The store creates its tables on construction (`CREATE TABLE IF NOT EXISTS`). You never need to create them manually — just point it at a file and it handles the rest.

### Persistent flows + SQLiteStore

With `SQLiteStore`, `flow(...).persistent()` checkpoints survive process restarts for free:

```ts
import { Bot, flow } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})

bot.use(
  flow('registro')
    .persistent()          // ← checkpoint saved to SQLite after each step
    .ask('¿Tu nombre?', 'name')
    .ask('¿Tu email?', 'email')
    .say((_ctx, c) => `✅ Registrado: ${c.state.name}`)
)
```

If the process crashes mid-flow, the next message from that user **resumes at the exact step** where it left off.

## RedisStore (distributed)

When you need state shared across processes/instances (horizontal scaling, TTL'd per-chat logs), use the Redis store:

```bash
pnpm add @bot-wa/redis-store
```

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { RedisStore } from '@bot-wa/redis-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  store: new RedisStore({ url: 'redis://localhost:6379' }),
})
```

## User data tables

[`ctx.user`](./user-data) profiles are stored next to the rest of the bot
state, honouring `tablePrefix` / `collectionPrefix`:

| Store | Where |
| --- | --- |
| `MemoryStore` | in memory; the JSON `file` gains a `userData` field (older files still load) |
| `SQLiteStore` | table `user_data` (`user_id`, `namespace`, `key`, `value_json`, `expires_at`, `updated_at`) + index on `expires_at` |
| `PostgresStore` | table `{prefix}user_data` (value as `TEXT`, not JSONB, to keep the exact JSON: U+0000 and unpaired surrogates round-trip unchanged, as JSON `\u0000` escapes) + expiry index |
| `MysqlStore` | table `{prefix}user_data`: ids, namespace and key as `VARBINARY` (byte-exact), value `MEDIUMTEXT` (16 MiB) |
| `MongoStore` | collection `{prefix}user_data`, indexes on `{ userId, namespace }` and `expiresAt` |
| `RedisStore` | one key per entry, `{prefix}:ud:{user}:{ns}:{key}`, with native `PX` expiry; listing and namespace deletes use `KEYS`, like `listChats` |

Postgres and MySQL now create seven tables in `start()`. Expired rows are
removed lazily by `bot.purgeExpiredUserData()` (Redis expires them by
itself).

## Custom stores

Implement the `IStore` interface to plug in any other backend (MongoDB, PostgreSQL and MySQL already have experimental stores in the monorepo):

```ts
import type { IStore } from '@bot-wa/core'

class MyStore implements IStore {
  async saveMessage(msg) { /* ... */ }
  async getMessage(ref) { /* ... */ }
  // ... implement every method
}

const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  store: new MyStore({ /* ... */ }),
})
```

The full interface is documented in the [API reference](/api/interfaces/IStore.html). `MemoryStore` is the reference implementation of the contract; inside the monorepo, every store runs the shared conformance suite (`test-utils/store-conformance.ts`).

Semantics every store must keep:

- `upsertChat` / `upsertContact` **shallow-merge** onto the stored record. An
  own field set to `undefined` **unsets** that field, so a partial upsert must
  omit what it does not know. The `Bot` already does: a message without a
  display name (or chat name) never erases the one stored.
- `deleteChat` also deletes that chat's message log.
- `maxMessagesPerChat` is opt-in; by default the message log is unbounded.

The user-data methods (`getUserData`, `setUserData`, `deleteUserData`,
`listUserData`, `purgeExpiredUserData`) are optional: without them
`ctx.user` rejects with `UNSUPPORTED_STORE`. If you add them, also pass
`runUserDataConformance` from `test-utils/user-data-conformance.ts`. A
store with `getCursor`/`setCursor` also persists the [`WELCOME`](./triggers#welcome)
markers and the [handoff](./handoff) index.

## Docker + SQLiteStore

Mount the data directory as a volume so the database survives container restarts:

```yaml
# docker-compose.yml
services:
  bot:
    build: .
    volumes:
      - ./sessions:/app/sessions   # WhatsApp auth
      - ./data:/app/data           # SQLite database
```
