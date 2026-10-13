# @bot-wa/mongo-store

> [!WARNING]
> **Experimental — not yet published on npm** (`"private": true`). The API may change without notice.

MongoDB [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — persistent, shared bot state backed by MongoDB (official driver v6). Point any number of bot replicas at the same MongoDB deployment and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Six collections (`messages`, `chats`, `contacts`, `checkpoints`, `conversations`, `cursors`), each optionally **prefixed**, inside one configurable **database** — apps/bots can share a cluster.
- `getMessagesByChat(limit)` is served by a compound `{chatId: 1, timestamp: 1}` index (created on `start()`) and returns the most-recent `limit` messages **ascending** by timestamp — same windowing semantics as `@bot-wa/redis-store` / `@bot-wa/sqlite-store`.
- Every write is an **upsert** keyed by `_id` (`messageKey(ref)` for messages, the entity id for chats/contacts, the logical key for the rest) — safe under concurrent replicas.
- Injectable client → fully hermetic unit tests (an in-memory fake ships with the test-suite), plus an opt-in [integration suite](#integration-tests) against a real MongoDB.

## Install

```bash
pnpm add @bot-wa/mongo-store mongodb
```

Requires a **running MongoDB instance** reachable from the bot (e.g. `mongodb://localhost:27017` — a local `mongod`, Docker: `docker run -p 27017:27017 mongo:7`, or Atlas). The driver is a direct dependency; no native build step.

## Usage with Bot

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { MongoStore } from '@bot-wa/mongo-store'

const store = new MongoStore({
  url: process.env.MONGO_URL,     // default: mongodb://localhost:27017
  dbName: 'mybot',                // default: 'botwa'
  collectionPrefix: 'prod_',      // default: ''
})
await store.start()               // connects the client (unless one was injected) + creates the messages index

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo' }),
  store,
})
```

`stop()` closes the client **only when the store created it** — an injected client stays open for its owner to manage.

### Injecting an existing client

Pass an already-created (usually already-connected) `MongoClient` — the store then never connects or closes it, the caller owns the lifecycle:

```ts
import { MongoClient } from 'mongodb'

const client = new MongoClient(process.env.MONGO_URL!)
await client.connect()

const store = new MongoStore({ client })   // no url needed
```

In tests, inject an in-memory fake instead (see `tests/fakeMongo.ts` in this package) so the suite runs with no network and no real MongoDB:

```ts
const fake = new FakeMongoClient()
const store = new MongoStore({ client: fake })
```

## Configuration

| Option             | Type                       | Default                     | Description |
| ------------------ | -------------------------- | --------------------------- | ----------- |
| `url`              | `string`                   | `mongodb://localhost:27017` | MongoDB connection URL. Ignored when `client` is provided. |
| `dbName`           | `string`                   | `'botwa'`                   | Database holding the store's collections. |
| `collectionPrefix` | `string`                   | `''`                        | Prefix applied to every collection name. |
| `client`           | `MongoClient \| MongoLikeClient` | —                     | Inject an existing client (required for tests). The store never connects/closes it. |
| `maxMessagesPerChat` | `number`                 | — (unbounded)               | When set, `saveMessage` prunes each chat's oldest messages (by timestamp) beyond the cap. |
| `logger`           | `{ error? }`               | —                           | Receives lifecycle errors (e.g. close failure). |

## Collection layout

| Collection          | `_id`              | Document |
| ------------------- | ------------------ | -------- |
| `{prefix}messages`      | `messageKey(ref)` (`{chatId}:{id}`) | `{ chatId, timestamp, msg: StoredMessage }` — indexed by `{chatId: 1, timestamp: 1}` |
| `{prefix}chats`         | `chat.id`          | the whole `StoredChat` |
| `{prefix}contacts`      | `contact.id`       | the whole `StoredContact` |
| `{prefix}checkpoints`   | key                | `{ cp: FlowCheckpoint }` |
| `{prefix}conversations` | key                | `{ messages: AIMessage[] }` |
| `{prefix}cursors`       | key                | `{ value: string }` (delivery cursor, e.g. Telegram `update_id`) |

`deleteChat(chatId)` removes the chat document **and** purges that chat's message log (same semantics as `MemoryStore` and the other stores). `upsertChat` / `upsertContact` shallow-merge over the existing document: fields you pass replace the stored ones, omitted fields are kept, and a field passed explicitly as `undefined` is removed.

## BSON notes

- `undefined` is never stored as `null`: nested `undefined` values are dropped (JSON semantics), so a `StoredMessage` saved with `body: undefined` reads back without `body`.
- Binary data inside `raw` / checkpoint state (`Buffer`, `Uint8Array`) reads back as a Node `Buffer`, not the driver's `Binary` class.
- Every document is limited to MongoDB's **16 MB** BSON cap — a single message, checkpoint or AI conversation history larger than that is rejected by the write (the previous value is kept). Field names may contain `.` and `$` but not NUL (`\0`).

## Integration tests

The default `pnpm test` is hermetic: the unit tests use the in-memory fake and `tests/integration.test.ts` is **skipped**. To run it against a real MongoDB (the shared `IStore` conformance suite plus index creation, persistence across restarts, trimming, merges, unicode, large values and concurrent writes), set `BOTWA_TEST_MONGO_URL`:

```bash
docker run -d --name botwa-it-mongo -p 57017:27017 mongo:7
BOTWA_TEST_MONGO_URL=mongodb://127.0.0.1:57017 pnpm --filter @bot-wa/mongo-store test
docker rm -f botwa-it-mongo
```

Each run works in its own database (`botwa_it_<random>`, dropped at the end) with a unique collection prefix per store, so reruns never collide. Use `127.0.0.1` rather than `localhost`: with Docker Desktop on Windows, `localhost` may resolve to `::1` first and the driver then times out on server selection. CI provides the same variable pointing at a MongoDB service container.
