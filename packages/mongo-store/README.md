# @bot-wa/mongo-store

MongoDB [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — persistent, shared bot state backed by MongoDB (official driver v6). Point any number of bot replicas at the same MongoDB deployment and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Six collections (`messages`, `chats`, `contacts`, `checkpoints`, `conversations`, `cursors`), each optionally **prefixed**, inside one configurable **database** — apps/bots can share a cluster.
- `getMessagesByChat(limit)` is served by a compound `{chatId: 1, timestamp: 1}` index (created on `start()`) and returns the most-recent `limit` messages **ascending** by timestamp — same windowing semantics as `@bot-wa/redis-store` / `@bot-wa/sqlite-store`.
- Every write is an **upsert** keyed by `_id` (`messageKey(ref)` for messages, the entity id for chats/contacts, the logical key for the rest) — safe under concurrent replicas.
- Injectable client → fully hermetic tests (an in-memory fake ships with the test-suite; no real MongoDB needed).

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

Note: `deleteChat(chatId)` removes the chat document **and** purges that chat's message log. Delete messages individually with `deleteMessage(ref)` if you need finer control.
