# @botmesh/manager

> **Experimental — not yet published on npm.** It is a real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

Multi-bot orchestrator for [`@botmesh/core`](../core): it manages many
`Bot` instances from a single registry. Add and remove bots by id, track
their running state, start or stop them one by one or all at once and,
if you want, expose everything with a small dependency-free HTTP API.

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { BotManager, createManagerApi } from '@botmesh/manager'
import { createServer } from 'node:http'

const manager = new BotManager()

manager.on('error', ({ id, error }) => console.error(`[${id}]`, error))
manager.on('started', (id) => console.log(`[${id}] up`))

const bot = new Bot({ provider: new BaileysProvider({ session: 'acme' }) })
bot.when('hello', async (ctx) => ctx.reply('Hello! 👋'))

const id = manager.add(bot, { id: 'acme', meta: { tenant: 'Acme Corp' } })
// id === 'acme' ('bot-N' is generated when you do not pass an id)

await manager.start(id)
console.log(manager.list()) // [{ id: 'acme', running: true, meta: { tenant: 'Acme Corp' } }]

// Optional HTTP control plane. Always set a token: without `auth` the API has no authentication.
createServer(createManagerApi(manager, { prefix: '/api', auth: { token: process.env.MANAGER_TOKEN! } })).listen(3000)
```

## BotManager

`BotManager extends EventEmitter`. A bot is considered **running** between a
successful `start(id)` and its `stop(id)`: the manager keeps the set of running
ids internally and updates it around each bot's `start()`/`stop()`.

Any object with `start()` / `stop()` can be managed (a core `Bot` or a stub)
through the structural `ManageableBot` interface.

### Registry

| Method | Returns | Notes |
| --- | --- | --- |
| `add(bot, opts?: { id?, tenantId?, name?, meta? })` | `string` (the id) | Automatic `bot-N` id when omitted (never collides); **throws when the id is duplicated**. Emits `added`. |
| `get(id)` | `ManageableBot \| undefined` | The bot instance. |
| `has(id)` | `boolean` | |
| `remove(id)` | `Promise<boolean>` | Stops the bot first when it is running (a failed `stop` emits `error` but does not prevent removal). Emits `removed`. `false` when the id does not exist. |
| `list()` | `Array<{ id, running, tenantId?, name?, meta? }>` | Snapshot of every bot's state. |
| `status(id)` | `{ id, running, tenantId?, name?, meta? } \| undefined` | Snapshot of one bot's state. |
| `entries()` | `BotEntry[]` | Full entries: `{ id, bot, createdAt, tenantId?, name?, meta? }`. |
| `isRunning(id)` | `boolean` | |
| `size` | `number` (getter) | Number of registered bots. |

### Lifecycle

| Method | Behavior |
| --- | --- |
| `start(id)` / `stop(id)` | `Promise<void>`. Idempotent (they do nothing when already running / stopped). They throw on unknown ids; they rethrow bot failures after emitting `error`. A failed `stop` leaves the bot marked as running. |
| `restart(id, { recreate? })` | Stops (when running) and starts again; emits `restarted`. `recreate: true` rebuilds a config-backed bot with the factory. |
| `startAll()` / `stopAll()` | `Promise<Record<string, 'ok' \| Error>>`. They run **in parallel** and never throw: failures are collected by id in the result map. |
| `shutdown()` | Cancels pending reconnections and stops every bot **without** changing the persisted desired state (so `restore()` brings them back up). |

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
| `added` | `id: string` | After registering a bot with `add()`. |
| `removed` | `id: string` | After removing a bot with `remove()`. |
| `started` | `id: string` | After a successful `start(id)`. |
| `stopped` | `id: string` | After a successful `stop(id)`. |
| `restarted` | `id: string` | After a `restart(id)` (manual or from the supervisor). |
| `error` | `{ id: string, error: unknown }` | A lifecycle operation failed (it is also rethrown or appears in the result maps). |
| `connection` | `{ id, state, reason?, authPayload?, updatedAt? }` | A bot's connection state changed (bots that emit `connection`). |
| `reconnecting` / `reconnected` / `reconnectFailed` | `{ id, attempt, delayMs, reason }` / `{ id, attempts }` / `{ id, attempts, error? }` | Supervisor activity (see *Automatic reconnection*). |

Listeners are typed with `ManagerEventMap`. A default no-op `error` listener is
installed so an unobserved failure never crashes the process through
`EventEmitter` semantics; add your own `error` listener to handle them.

## HTTP API

There are three HTTP surfaces. The complete one is **`createRestApi`** (see *Full `/v1` REST API* below). `createControlPlaneApi(manager, { tenantId, apiKeys })` is a minimal, audited `/v1` surface with no anonymous mode (it also uses the `/v1` prefix by default, so do not mount it next to `createRestApi` on the same prefix). Every API key carries scopes, every response includes `x-request-id` and lifecycle operations accept an `Idempotency-Key`.

```ts
createServer(createControlPlaneApi(manager, {
  tenantId: 'acme',
  apiKeys: [{ id: 'ops', tenantId: 'acme', secret: process.env.MANAGER_KEY!, scopes: ['bots:read', 'bots:operate', 'audit:read'] }],
})).listen(3000)
```

Initial routes: `GET /v1/health`, `GET /v1/bots`, `POST /v1/bots/:id/start`, `POST /v1/bots/:id/stop` and `GET /v1/audit`. See the [control plane guide](https://github.com/andresayac/botmesh/blob/main/docs/es/guide/control-plane.md).

The legacy compact API, `createManagerApi(manager, opts?: { prefix?, auth?: { token, header? } })`,
returns a Node handler `(req, res) => void` (it only uses `node:http`: mount it
in `http.createServer` or call it from any framework). All
responses are JSON. With `auth`, every request must present the token
(`Authorization: Bearer <token>` by default, or the header set in
`auth.header`; timing-safe comparison) or it receives `401`. **Without `auth` the API has
no authentication**: anyone who can reach the socket can list, start
and stop bots, and a warning is logged once.

| Route | Success | Errors |
| --- | --- | --- |
| `GET {prefix}/health` | `200` — `{ status: 'ok', bots, running }` | |
| `GET {prefix}/metrics` | `200` — Prometheus text (`botwa_manager_bots_registered`, `botwa_manager_bots_running`) | |
| `GET {prefix}/bots` | `200` — `Array<{ id, running, meta }>` | |
| `GET {prefix}/bots/:id` | `200` — `{ id, running, meta }` | `404 { error }` unknown id |
| `POST {prefix}/bots/:id/start` | `200` — `{ id, running: true }` | `404` unknown id · `500 { error }` start failure |
| `POST {prefix}/bots/:id/stop` | `200` — `{ id, running: false }` | `404` unknown id · `500 { error }` stop failure |

Any other route or method → `404 { "error": "not found" }`. URL ids may be
percent-encoded.

```bash
H="Authorization: Bearer $MANAGER_TOKEN"
curl -H "$H" localhost:3000/api/bots                 # list
curl -H "$H" localhost:3000/api/bots/acme            # status
curl -H "$H" -X POST localhost:3000/api/bots/acme/start
curl -H "$H" -X POST localhost:3000/api/bots/acme/stop
```

## Full `/v1` REST API (`createRestApi`)

`createRestApi(manager, { tokens })` is the recommended API for platforms: pure `node:http`, dependency-free, with an **OpenAPI 3.1** document at `GET /v1/openapi.json`.

```ts
import { createServer } from 'node:http'
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { BotManager, createRestApi } from '@botmesh/manager'

const manager = new BotManager({
  // Build a bot from its serializable config (never store raw secrets in provider.options).
  factory: (cfg) => new Bot({
    provider: new BaileysProvider({ session: `${cfg.tenantId}-${cfg.id}` }),
    tenantId: cfg.tenantId,
    botId: cfg.id,
  }),
  persistence: { dir: './data/bots' },          // <dir>/<tenantId>/<botId>.json (atomic write, 0600)
  autoReconnect: { maxRetries: 5, initialDelay: 1000, maxDelay: 30_000, jitter: 0.2 },
})
await manager.restore()                          // rebuild saved bots and start the ones that were "running"

createServer(createRestApi(manager, {
  tokens: [
    { id: 'ops', token: process.env.OPS_TOKEN!, scopes: ['*'] },                                  // all tenants
    { id: 'acme', token: process.env.ACME_TOKEN!, tenantId: 'acme', scopes: ['bots:read', 'messages:send'] },
  ],
})).listen(3000)
process.on('SIGTERM', () => void manager.shutdown())   // stop everything without touching the persisted desiredState
```

| Route (`/v1/...`) | Scope |
| --- | --- |
| `GET /health`, `GET /openapi.json`, `GET /flows/schema` | public (`publicDocs: false` requires a token for docs) |
| `GET/POST /bots`, `GET/PUT/DELETE /bots/{id}` | `bots:read` / `bots:write` |
| `POST /bots/{id}/start\|stop\|restart` | `bots:operate` |
| `GET /bots/{id}/connection` (state + QR/pairing code) | `connections:read` |
| `POST /bots/{id}/send` | `messages:send` |
| `GET /bots/{id}/messages?chatId=&limit=&cursor=` | `messages:read` |
| `POST /bots/{id}/trigger`, `GET /bots/{id}/conversations`, `POST /bots/{id}/conversations/{key}/cancel` | `conversations:*` |
| `GET/POST /bots/{id}/flows`, `GET/PUT/DELETE /bots/{id}/flows/{flowId}` | `flows:*` |
| `GET /metrics`, `GET /bots/{id}/metrics` | `metrics:read` |

Also: `X-Request-Id` on every response, per-token rate limiting (`RateLimit-*`, `Retry-After`), `Idempotency-Key` on mutating routes (24 h replay, `422` when reused with a different body), body limit (`413`), `415` when not JSON, tenant isolation (a tenant token never sees other bots: `404`). Errors follow `{ error: { code, message, requestId, details? } }`.

## Dynamic JSON flows

`compileFlowDocument(doc)` turns a JSON document (no code) into a `CompiledFlow` registered with `bot.registerFlow()` / `bot.replaceFlow()`. Steps: `say`, `ask` (with `validate.expr`), `choose`, `delay`, `goto`, `end`, `condition`; `{{ path }}` templates and safe expressions (`len(name) > 2 && oneOf(plan, "pro", "max")`). Versioned JSON Schema: `FLOW_DOCUMENT_SCHEMA` (`GET /v1/flows/schema`).

## Automatic reconnection

With `autoReconnect`, if the connection drops (`connection: closed`, except `sessionTakenOver`) and the provider does not recover on its own within `graceMs`, or if a start fails, the manager restarts the bot with exponential backoff + jitter up to `maxRetries` (`reconnecting`, `reconnected`, `reconnectFailed` events). Config-backed bots are recreated with the factory (fresh provider).

## Logging

The manager logs lifecycle events with pino at `debug`/`warn`.
Inject your own logger (`new BotManager({ logger })`) or enable the default
one with `BOTWA_MANAGER_LOG_LEVEL=debug` (default: `silent`).

## Development

```bash
pnpm --filter @botmesh/manager build   # tsc → lib/
pnpm --filter @botmesh/manager test    # vitest (hermetic: fake bots, no network)
```
