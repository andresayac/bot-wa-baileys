# @bot-wa/manager

Multi-bot orchestrator for [`@bot-wa/core`](../core) — manage many `Bot`
instances behind one registry: add/remove by id, track running state,
start/stop individually or all at once, and (optionally) expose everything
over a tiny zero-dependency HTTP API.

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { BotManager, createManagerApi } from '@bot-wa/manager'
import { createServer } from 'node:http'

const manager = new BotManager()

manager.on('error', ({ id, error }) => console.error(`[${id}]`, error))
manager.on('started', (id) => console.log(`[${id}] up`))

const bot = new Bot({ provider: new BaileysProvider({ session: 'acme' }) })
bot.when('hola', async (ctx) => ctx.reply('¡Hola! 👋'))

const id = manager.add(bot, { id: 'acme', meta: { tenant: 'Acme Corp' } })
// id === 'acme' (auto-generated 'bot-N' when no id is given)

await manager.start(id)
console.log(manager.list()) // [{ id: 'acme', running: true, meta: { tenant: 'Acme Corp' } }]

// Control plane over HTTP (optional)
createServer(createManagerApi(manager, { prefix: '/api' })).listen(3000)
```

## BotManager

`BotManager extends EventEmitter`. A bot is considered **running** between a
successful `start(id)` and `stop(id)` — the manager keeps an internal set of
running ids, updated around each bot's `start()`/`stop()`.

Anything with `start()` / `stop()` is manageable — a core `Bot` or a plain
stub — via the structural `ManageableBot` interface.

### Registry

| Method | Returns | Notes |
| --- | --- | --- |
| `add(bot, opts?: { id?, meta? })` | `string` (the id) | Auto id `bot-N` when omitted (never collides); **throws on duplicate id**. Emits `added`. |
| `get(id)` | `ManageableBot \| undefined` | The bot instance. |
| `has(id)` | `boolean` | |
| `remove(id)` | `Promise<boolean>` | Stops the bot first if running (a failed stop emits `error` but does not block removal). Emits `removed`. `false` when unknown. |
| `list()` | `Array<{ id, running, meta }>` | Status snapshot of every bot. |
| `status(id)` | `{ id, running, meta } \| undefined` | Snapshot of one bot. |
| `entries()` | `BotEntry[]` | Full entries: `{ id, bot, createdAt, meta? }`. |
| `isRunning(id)` | `boolean` | |
| `size` | `number` (getter) | Registered bot count. |

### Lifecycle

| Method | Behavior |
| --- | --- |
| `start(id)` / `stop(id)` | `Promise<void>`. Idempotent (no-op if already running / not running). Throw for unknown ids; re-throw bot failures after emitting `error`. A failed `stop` leaves the bot marked running. |
| `startAll()` / `stopAll()` | `Promise<Record<string, 'ok' \| Error>>`. Run **in parallel** and never throw — failures are collected per id in the results map. |

```ts
const results = await manager.startAll()
// { acme: 'ok', beta: Error('connect ECONNREFUSED …') }
for (const [id, outcome] of Object.entries(results)) {
  if (outcome !== 'ok') console.error(id, outcome.message)
}
await manager.stopAll()
```

### Events

| Event | Payload | When |
| --- | --- | --- |
| `added` | `id: string` | After `add()` registers a bot. |
| `removed` | `id: string` | After `remove()` unregisters a bot. |
| `started` | `id: string` | After `start(id)` succeeds. |
| `stopped` | `id: string` | After `stop(id)` succeeds. |
| `error` | `{ id: string, error: unknown }` | A lifecycle operation failed (also re-thrown / present in results maps). |

Listeners are typed via `ManagerEventMap`. A no-op default `error` listener
is installed so an unobserved failure can never crash the process through
`EventEmitter` semantics — attach your own `error` listener to handle them.

## HTTP API

`createManagerApi(manager, opts?: { prefix? })` returns a plain Node
`(req, res) => void` handler (uses `node:http` only — mount it on
`http.createServer` or call it from any framework). Every response is JSON.

| Route | Success | Errors |
| --- | --- | --- |
| `GET {prefix}/bots` | `200` — `Array<{ id, running, meta }>` | |
| `GET {prefix}/bots/:id` | `200` — `{ id, running, meta }` | `404 { error }` unknown id |
| `POST {prefix}/bots/:id/start` | `200` — `{ id, running: true }` | `404` unknown id · `500 { error }` start failure |
| `POST {prefix}/bots/:id/stop` | `200` — `{ id, running: false }` | `404` unknown id · `500 { error }` stop failure |

Any other route/method → `404 { "error": "not found" }`. Ids in URLs may be
percent-encoded.

```bash
curl localhost:3000/api/bots                 # list
curl localhost:3000/api/bots/acme            # status
curl -X POST localhost:3000/api/bots/acme/start
curl -X POST localhost:3000/api/bots/acme/stop
```

## Logging

The manager logs lifecycle events through pino at `debug`/`warn`. Inject your
own logger (`new BotManager({ logger })`) or enable the default one with
`BOTWA_MANAGER_LOG_LEVEL=debug` (default: `silent`).

## Development

```bash
pnpm --filter @bot-wa/manager build   # tsc → lib/
pnpm --filter @bot-wa/manager test    # vitest (hermetic: fake bots, no network)
```
