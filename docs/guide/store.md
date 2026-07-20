# Persistent Store

The **store** is where the bot keeps messages, chats, contacts, flow state, checkpoints and AI conversation history. Choosing the right store is the difference between a bot that forgets everything on restart and one that survives deploys.

## Built-in stores

| Store | Persistence | Use case |
|---|---|---|
| `MemoryStore` *(default)* | In-memory (optional JSON dump) | Development, tests, short-lived bots |
| `SQLiteStore` | SQLite file (WAL mode) | **Production** — single-bot, zero-config |

## MemoryStore (default)

If you don't pass a `store`, the bot creates a `MemoryStore`. Everything lives in RAM; an optional JSON file can snapshot chats/contacts/checkpoints (not messages) on an interval.

```ts
const bot = new Bot({
  session: 'my-bot',
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

A real database backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — synchronous, zero-config, single-file. Perfect for a single bot instance on a VPS or Docker container.

```ts
import { Bot, SQLiteStore } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({
  session: 'my-bot',
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `file` | `string` | `'./bot.db'` | Path to the SQLite database file |
| `wal` | `boolean` | `true` | Enable WAL mode (better concurrent reads) |
| `logger` | `object` | — | Logger for errors (`{ error: fn }`) |

### What it stores

| Table | Content |
|---|---|
| `messages` | Every inbound/outbound message (keyed by chat + timestamp) |
| `chats` | Chat metadata (name, unread, etc.) |
| `contacts` | Contact info (push name, etc.) |
| `flow_states` | Per-user flow state (`c.state`) |
| `checkpoints` | `persistent()` flow checkpoints — survive restarts |
| `conversations` | AI conversation history (`@bot-wa/ai`) |

### Schema migrations

The store runs **automatic migrations** on startup. You never need to create tables manually — just point it at a file and it handles the rest.

### Persistent flows + SQLiteStore

With `SQLiteStore`, `flow(...).persistent()` checkpoints survive process restarts for free:

```ts
import { Bot, SQLiteStore, flow } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({
  session: 'my-bot',
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

## Custom stores

Implement the `IStore` interface to plug in Redis, Postgres, Mongo, etc.:

```ts
import type { IStore } from '@bot-wa/bot-wa-baileys'

class RedisStore implements IStore {
  async saveMessage(msg) { /* ... */ }
  async getMessage(key) { /* ... */ }
  // ... implement every method
}

const bot = new Bot({
  session: 'my-bot',
  store: new RedisStore({ url: 'redis://localhost:6379' }),
})
```

The full interface is documented in the [API reference](/api/interfaces/IStore.html).

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
