# @bot-wa/redis-store

Redis [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — distributed, shared bot state backed by Redis (node-redis v4). Point any number of bot replicas at the same Redis instance and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Per-chat message logs as Redis **sorted sets** (score = timestamp) → `getMessagesByChat(limit)` is an `O(log N + limit)` `ZRANGE`, not a scan.
- Everything is JSON under one configurable **prefix**, so apps/bots can share a database.
- Optional **TTL** for ephemeral session state (conversations, checkpoints).
- Injectable client → fully hermetic tests (an in-memory fake ships with the test-suite; no real Redis needed).
- Ships a small **distributed lock** helper (`acquireLock` / `releaseLock`) as the building block for multi-replica FIFO message processing.

## Install

```bash
pnpm add @bot-wa/redis-store redis
```

(Requires a Redis server reachable from the bot, e.g. `redis://localhost:6379`.)

## Usage with Bot

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { RedisStore } from '@bot-wa/redis-store'

const store = new RedisStore({
  url: process.env.REDIS_URL,      // default: redis://localhost:6379
  prefix: 'mybot',                 // default: 'botwa'
  ttl: 7 * 24 * 60 * 60,           // optional: expire conversations/checkpoints after 7 days
})
await store.start()                // connects the client (unless one was injected)

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo' }),
  store,
})
```

### Injecting an existing client

Pass an already-created (usually already-connected) client — the store then never connects or quits it, the caller owns the lifecycle:

```ts
import { createClient } from 'redis'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

const store = new RedisStore({ client })   // no url needed
```

In tests, inject an in-memory fake instead (see `tests/fakeRedis.ts` in this package) so the suite runs with no network and no real Redis:

```ts
const fake = new FakeRedisClient()
const store = new RedisStore({ client: fake })
```

## Configuration

| Option   | Type              | Default                   | Description |
| -------- | ----------------- | ------------------------- | ----------- |
| `url`    | `string`          | `redis://localhost:6379`  | Redis connection URL. Ignored when `client` is provided. |
| `prefix` | `string`          | `'botwa'`                 | Namespace prefix for every key. |
| `client` | `RedisLikeClient` | —                         | Inject an existing client (required for tests). The store never connects/quits it. |
| `ttl`    | `number`          | —                         | TTL in **seconds** for AI conversations and flow checkpoints. Messages, chats, contacts and cursors never expire — delete them explicitly. |
| `logger` | `{ error? }`    | —                         | Receives lifecycle errors (e.g. quit failure). |

## Key scheme

| Key | Type | Contents | TTL |
| --- | ---- | -------- | --- |
| `{prefix}:msg:{chatId}` | ZSET | `messageKey` → timestamp (per-chat index) | — |
| `{prefix}:msg:item:{chatId}:{id}` | string (JSON) | `StoredMessage` | — |
| `{prefix}:chat:{id}` | string (JSON) | `StoredChat` | — |
| `{prefix}:contact:{id}` | string (JSON) | `StoredContact` | — |
| `{prefix}:cp:{key}` | string (JSON) | `FlowCheckpoint` | `ttl` |
| `{prefix}:conv:{key}` | string (JSON) | `AIMessage[]` | `ttl` |
| `{prefix}:cursor:{key}` | string | delivery cursor (e.g. Telegram `update_id`) | — |
| `{prefix}:lock:{key}` | string | lock token (`SET NX PX`) | lock `ttlMs` |

`getMessagesByChat(chatId, limit)` reads the latest `limit` entries from the ZSET (`ZRANGE … BYSCORE REV LIMIT`) and fetches the JSON items, returning them oldest→newest — same windowing semantics as `@bot-wa/sqlite-store`.

## Distributed lock

`RedisStore` exposes a minimal lock, the building block for coordinating work across replicas (e.g. FIFO processing of one chat on exactly one replica). The core does **not** use it yet — it is there for you to compose with.

```ts
const token = await store.acquireLock(`chat:${chatId}`, 30_000) // SET NX PX
if (!token) return // another replica holds it

try {
  await processChat(chatId)
} finally {
  await store.releaseLock(`chat:${chatId}`, token) // Lua compare-and-delete
}
```

- `acquireLock(key, ttlMs = 30_000)` → opaque token on success, `null` when already held. The `PX` deadline guarantees a crashed holder never wedges the fleet.
- `releaseLock(key, token)` → `true` only if the token still owns the lock. Release is an atomic Lua compare-and-delete, so a slow holder can never delete a newer owner's lock.

## Notes

- Designed for **distributed state**: multiple bot replicas sharing one Redis get a consistent view of history, checkpoints and cursors.
- Listing (`listChats` / `listContacts` / `listCheckpoints`) uses `KEYS {prefix}:…:*` — fine at bot scale; switch to `SCAN` if you expect a very large keyspace on a shared server.
- Do not inject a client configured with `returnBuffers: true`; the store expects string replies.
- `start()` connects only a self-created client (and is idempotent); `stop()` quits only a self-created client.
