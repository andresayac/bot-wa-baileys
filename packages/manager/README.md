# @bot-wa/manager

> **Experimental — aún no publicado en npm** (experimental, not yet published to npm). A real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

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

// Control plane over HTTP (optional). Always set a token: without `auth` the API is unauthenticated.
createServer(createManagerApi(manager, { prefix: '/api', auth: { token: process.env.MANAGER_TOKEN! } })).listen(3000)
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
| `add(bot, opts?: { id?, tenantId?, name?, meta? })` | `string` (the id) | Auto id `bot-N` when omitted (never collides); **throws on duplicate id**. Emits `added`. |
| `get(id)` | `ManageableBot \| undefined` | The bot instance. |
| `has(id)` | `boolean` | |
| `remove(id)` | `Promise<boolean>` | Stops the bot first if running (a failed stop emits `error` but does not block removal). Emits `removed`. `false` when unknown. |
| `list()` | `Array<{ id, running, tenantId?, name?, meta? }>` | Status snapshot of every bot. |
| `status(id)` | `{ id, running, tenantId?, name?, meta? } \| undefined` | Snapshot of one bot. |
| `entries()` | `BotEntry[]` | Full entries: `{ id, bot, createdAt, tenantId?, name?, meta? }`. |
| `isRunning(id)` | `boolean` | |
| `size` | `number` (getter) | Registered bot count. |

### Lifecycle

| Method | Behavior |
| --- | --- |
| `start(id)` / `stop(id)` | `Promise<void>`. Idempotent (no-op if already running / not running). Throw for unknown ids; re-throw bot failures after emitting `error`. A failed `stop` leaves the bot marked running. |
| `restart(id, { recreate? })` | Stop (when running) and start again; emits `restarted`. `recreate: true` rebuilds a config-backed bot through the factory. |
| `startAll()` / `stopAll()` | `Promise<Record<string, 'ok' \| Error>>`. Run **in parallel** and never throw — failures are collected per id in the results map. |
| `shutdown()` | Cancel pending reconnects and stop every bot **without** changing the persisted desired state (so `restore()` brings them back). |

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
| `restarted` | `id: string` | After `restart(id)` (manual or by the supervisor). |
| `error` | `{ id: string, error: unknown }` | A lifecycle operation failed (also re-thrown / present in results maps). |
| `connection` | `{ id, state, reason?, authPayload?, updatedAt? }` | A bot's connection state changed (bots that emit `connection`). |
| `reconnecting` / `reconnected` / `reconnectFailed` | `{ id, attempt, delayMs, reason }` / `{ id, attempts }` / `{ id, attempts, error? }` | Supervisor activity (see *Reconexión automática*). |

Listeners are typed via `ManagerEventMap`. A no-op default `error` listener
is installed so an unobserved failure can never crash the process through
`EventEmitter` semantics — attach your own `error` listener to handle them.

## HTTP API

Three HTTP surfaces are available. The complete one is **`createRestApi`** (see *API REST `/v1` completa* below). `createControlPlaneApi(manager, { tenantId, apiKeys })` is a minimal, audited `/v1` surface with no anonymous mode (it also defaults to the `/v1` prefix, so do not mount it next to `createRestApi` on the same prefix). Every API key carries scopes, every response includes `x-request-id`, and lifecycle operations accept an `Idempotency-Key`.

```ts
createServer(createControlPlaneApi(manager, {
  tenantId: 'acme',
  apiKeys: [{ id: 'ops', tenantId: 'acme', secret: process.env.MANAGER_KEY!, scopes: ['bots:read', 'bots:operate', 'audit:read'] }],
})).listen(3000)
```

Initial routes: `GET /v1/health`, `GET /v1/bots`, `POST /v1/bots/:id/start`, `POST /v1/bots/:id/stop` and `GET /v1/audit`. See the [control plane guide](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/guide/control-plane.md).

The compact legacy API, `createManagerApi(manager, opts?: { prefix?, auth?: { token, header? } })`, returns a plain Node
`(req, res) => void` handler (uses `node:http` only — mount it on
`http.createServer` or call it from any framework). Every response is JSON.
With `auth`, every request must present the token (`Authorization: Bearer <token>`
by default, or the header named by `auth.header`; timing-safe compare) or it gets
`401`. **Without `auth` the API is unauthenticated** — anyone who can reach the socket
can list, start and stop bots — and a one-time warning is logged.

| Route | Success | Errors |
| --- | --- | --- |
| `GET {prefix}/health` | `200` — `{ status: 'ok', bots, running }` | |
| `GET {prefix}/metrics` | `200` — Prometheus text (`botwa_manager_bots_registered`, `botwa_manager_bots_running`) | |
| `GET {prefix}/bots` | `200` — `Array<{ id, running, meta }>` | |
| `GET {prefix}/bots/:id` | `200` — `{ id, running, meta }` | `404 { error }` unknown id |
| `POST {prefix}/bots/:id/start` | `200` — `{ id, running: true }` | `404` unknown id · `500 { error }` start failure |
| `POST {prefix}/bots/:id/stop` | `200` — `{ id, running: false }` | `404` unknown id · `500 { error }` stop failure |

Any other route/method → `404 { "error": "not found" }`. Ids in URLs may be
percent-encoded.

```bash
H="Authorization: Bearer $MANAGER_TOKEN"
curl -H "$H" localhost:3000/api/bots                 # list
curl -H "$H" localhost:3000/api/bots/acme            # status
curl -H "$H" -X POST localhost:3000/api/bots/acme/start
curl -H "$H" -X POST localhost:3000/api/bots/acme/stop
```

## API REST `/v1` completa (`createRestApi`)

`createRestApi(manager, { tokens })` es la API recomendada para plataformas: `node:http` puro, sin dependencias, con documento **OpenAPI 3.1** en `GET /v1/openapi.json`.

```ts
import { createServer } from 'node:http'
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { BotManager, createRestApi } from '@bot-wa/manager'

const manager = new BotManager({
  // Construye un bot a partir de su config serializable (nunca guardes secretos crudos en provider.options).
  factory: (cfg) => new Bot({
    provider: new BaileysProvider({ session: `${cfg.tenantId}-${cfg.id}` }),
    tenantId: cfg.tenantId,
    botId: cfg.id,
  }),
  persistence: { dir: './data/bots' },          // <dir>/<tenantId>/<botId>.json (escritura atómica, 0600)
  autoReconnect: { maxRetries: 5, initialDelay: 1000, maxDelay: 30_000, jitter: 0.2 },
})
await manager.restore()                          // reconstruye los bots guardados y arranca los que estaban "running"

createServer(createRestApi(manager, {
  tokens: [
    { id: 'ops', token: process.env.OPS_TOKEN!, scopes: ['*'] },                                  // todos los tenants
    { id: 'acme', token: process.env.ACME_TOKEN!, tenantId: 'acme', scopes: ['bots:read', 'messages:send'] },
  ],
})).listen(3000)
process.on('SIGTERM', () => void manager.shutdown())   // para todo sin tocar el desiredState persistido
```

| Ruta (`/v1/...`) | Scope |
| --- | --- |
| `GET /health`, `GET /openapi.json`, `GET /flows/schema` | público (`publicDocs: false` exige token para docs) |
| `GET/POST /bots`, `GET/PUT/DELETE /bots/{id}` | `bots:read` / `bots:write` |
| `POST /bots/{id}/start\|stop\|restart` | `bots:operate` |
| `GET /bots/{id}/connection` (estado + QR/código de emparejamiento) | `connections:read` |
| `POST /bots/{id}/send` | `messages:send` |
| `GET /bots/{id}/messages?chatId=&limit=&cursor=` | `messages:read` |
| `POST /bots/{id}/trigger`, `GET /bots/{id}/conversations`, `POST /bots/{id}/conversations/{key}/cancel` | `conversations:*` |
| `GET/POST /bots/{id}/flows`, `GET/PUT/DELETE /bots/{id}/flows/{flowId}` | `flows:*` |
| `GET /metrics`, `GET /bots/{id}/metrics` | `metrics:read` |

Además: `X-Request-Id` en todas las respuestas, rate limiting por token (`RateLimit-*`, `Retry-After`), `Idempotency-Key` en rutas que mutan (replay 24 h, `422` si se reutiliza con otro cuerpo), límite de cuerpo (`413`), `415` si no es JSON, aislamiento por tenant (un token de tenant no ve bots ajenos: `404`). Los errores siguen `{ error: { code, message, requestId, details? } }`.

## Flows JSON dinámicos

`compileFlowDocument(doc)` convierte un documento JSON (sin código) en un `CompiledFlow` que se registra con `bot.registerFlow()` / `bot.replaceFlow()`. Pasos: `say`, `ask` (con `validate.expr`), `choose`, `delay`, `goto`, `end`, `condition`; plantillas `{{ path }}` y expresiones seguras (`len(name) > 2 && oneOf(plan, "pro", "max")`). Esquema JSON versionado: `FLOW_DOCUMENT_SCHEMA` (`GET /v1/flows/schema`).

## Reconexión automática

Con `autoReconnect`, si la conexión se cae (`connection: closed`, salvo `sessionTakenOver`) y el provider no se recupera solo en `graceMs`, o si un arranque falla, el manager reinicia el bot con backoff exponencial + jitter hasta `maxRetries` (eventos `reconnecting`, `reconnected`, `reconnectFailed`). Los bots con config se recrean con la factory (provider nuevo).

## Logging

The manager logs lifecycle events through pino at `debug`/`warn`. Inject your
own logger (`new BotManager({ logger })`) or enable the default one with
`BOTWA_MANAGER_LOG_LEVEL=debug` (default: `silent`).

## Development

```bash
pnpm --filter @bot-wa/manager build   # tsc → lib/
pnpm --filter @bot-wa/manager test    # vitest (hermetic: fake bots, no network)
```
