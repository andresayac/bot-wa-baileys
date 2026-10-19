# @bot-wa/sqlite-store

SQLite [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core**: persistent bot state in a single file, backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). Message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors survive restarts with no server to run.

> **Alpha, first npm publish pending.** This package is part of the first alpha, but nothing is on npm yet. Until it is, use it from this monorepo (`workspace:*`); the `pnpm add` below is the command that will work once it is published.

- One file, zero config. Tables are created on construction (`CREATE TABLE IF NOT EXISTS`), so there are no migrations to run by hand.
- **WAL** journal mode by default (`synchronous = NORMAL`) for better concurrent reads.
- `getMessagesByChat(limit)` is served by a `(chat_id, timestamp)` index and returns the most recent `limit` messages **oldest→newest**, the same windowing semantics as `@bot-wa/redis-store`.
- Optional per-chat cap (`maxMessagesPerChat`) to bound growth; unbounded by default, since a persistent DB is often the full archive.
- Passes the shared `IStore` conformance suite (`test-utils/store-conformance.ts`), like every other store.

Best fit: a **single bot process** on a VPS or in a container. For several replicas sharing state, use `@bot-wa/redis-store`.

## Install

```bash
pnpm add @bot-wa/sqlite-store better-sqlite3
```

`better-sqlite3` is a peer dependency, a native module with prebuilt binaries for common platforms. It is loaded when the store is constructed; if it is missing, the constructor throws an error telling you to install it.

## Usage with Bot

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})

await bot.start()
```

The bot calls the store's `start()`/`stop()` for you. `stop()` closes the database (a close failure goes to `logger.error`).

With a durable store, `flow(...).persistent()` checkpoints survive a restart: the next message from that user resumes the flow at the saved step.

## Configuration

| Option               | Type          | Default      | Description |
| -------------------- | ------------- | ------------ | ----------- |
| `file`               | `string`      | `'./bot.db'` | Path to the SQLite database file. The directory must exist. |
| `wal`                | `boolean`     | `true`       | Enable WAL journal mode. |
| `maxMessagesPerChat` | `number`      | — (unbounded) | Keep only the newest N messages per chat; older rows are pruned on each `saveMessage`. Must be a non-negative integer (else `RangeError`). |
| `logger`             | `{ error? }`  | —            | Receives lifecycle errors (e.g. close failure). |

## Table layout

| Table           | Key                                 | Contents |
| --------------- | ----------------------------------- | -------- |
| `messages`      | `messageKey(ref)` (`{chatId}:{id}`) | `StoredMessage` as JSON, plus `chat_id`, `sender_id`, `timestamp`, `type`, `body`, `from_me` columns; indexed by `(chat_id, timestamp)` |
| `chats`         | `chat.id`                           | `StoredChat` (JSON) |
| `contacts`      | `contact.id`                        | `StoredContact` (JSON) |
| `checkpoints`   | key                                 | `FlowCheckpoint` (JSON: flow id, step, `c.state`) |
| `conversations` | key                                 | `AIMessage[]` (JSON), the `@bot-wa/ai` history |
| `cursors`       | key                                 | delivery cursor string (e.g. Telegram `update_id`) |

## Semantics

- `upsertChat` / `upsertContact` **shallow-merge** over the existing record, so a partial upsert never wipes fields set earlier. The read and the write run in one `IMMEDIATE` transaction, so concurrent upserts of the same record (from this process or another one sharing the file) never drop each other's fields.
- `deleteChat(chatId)` removes the chat **and** purges its message log in one transaction (consistent with `MemoryStore`).
- `saveMessage` is an upsert keyed by `messageKey(ref)`; re-saving a message replaces it. A message without `ref.id` or `chatId` is ignored, like in `MemoryStore`.
- `getMessagesByChat(chatId, limit)`: a `limit` of `0` or less returns nothing, a fraction rounds up and `Infinity` returns the whole log.
- Statements are prepared once per store, not on every call.

## Docker

Mount the directory that holds the database as a volume, next to the WhatsApp session:

```yaml
services:
  bot:
    build: .
    volumes:
      - ./sessions:/app/sessions   # WhatsApp auth (Baileys)
      - ./data:/app/data           # SQLite database
```

Back up `data/` together with `sessions/`.
