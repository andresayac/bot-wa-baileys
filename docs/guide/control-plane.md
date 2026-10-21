# Control plane

::: warning Experimental — not published yet
`@botmesh/manager` is **experimental**: a real, tested implementation that is
still private (not on npm, not part of the first alpha) and whose API may
change. Use it from the monorepo (`workspace:*`).
:::

`@botmesh/manager` runs many bots in one process and exposes them over HTTP. It
has four pieces:

- **`BotManager`**: a registry of bots (`add`, `start`, `stop`, `restart`,
  `startAll`, `stopAll`, `shutdown`) plus typed events.
- **Persistence and supervision**: serializable bot configs per tenant,
  `restore()` after a restart and automatic reconnects with backoff.
- **JSON flows**: declarative, code-free flow documents compiled to core flows
  and hot-swapped at runtime through the core
  [dynamic flow registry](#core-dynamic-flow-registry).
- **HTTP APIs**: the full `/v1` REST API (`createRestApi`, with an OpenAPI 3.1
  document), plus two smaller surfaces (`createControlPlaneApi` and the legacy
  `createManagerApi`).

All HTTP handlers are plain `node:http` handlers with no dependencies.

## Quick start

```ts
import { createServer } from 'node:http'
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { BotManager, createRestApi } from '@botmesh/manager'

const manager = new BotManager({
  // Builds a bot from its serializable config (never store raw secrets in provider.options).
  factory: (cfg) => new Bot({
    provider: new BaileysProvider({ session: `${cfg.tenantId}-${cfg.id}` }),
    tenantId: cfg.tenantId,
    botId: cfg.id,
  }),
  persistence: { dir: './data/bots' },   // <dir>/<tenantId>/<botId>.json
  autoReconnect: true,
})
await manager.restore()                   // rebuild saved bots, start the ones that were running

createServer(createRestApi(manager, {
  tokens: [
    { id: 'ops', token: process.env.OPS_TOKEN!, scopes: ['*'] },   // every tenant
    { id: 'acme', token: process.env.ACME_TOKEN!, tenantId: 'acme', scopes: ['bots:read', 'messages:send'] },
  ],
})).listen(3000)

process.on('SIGTERM', () => void manager.shutdown())   // stops everything, keeps the persisted desired state
```

## `BotManager`

Anything with `start()` / `stop()` can be managed (the structural
`ManageableBot` type): a core `Bot` or a plain stub. Features beyond
start/stop (sending, flows, conversations, message history) are used only when
the bot has the matching method; otherwise the REST API answers
`501 NOT_SUPPORTED`. A core `Bot` has all of them.

| Method | Notes |
| --- | --- |
| `add(bot, { id?, tenantId?, name?, meta? })` | Registers a bot and returns its id (`bot-N` when omitted). Throws on a duplicate id. |
| `get(id)` / `has(id)` / `remove(id)` | `remove` stops the bot first; a persisted config is kept (use `deleteBot`). |
| `list()` / `status(id)` / `entries()` / `isRunning(id)` / `size` | Status snapshots: `{ id, running, tenantId?, name?, meta? }`. |
| `start(id)` / `stop(id)` | Idempotent. Throw for unknown ids and rethrow bot failures after emitting `error`. They also persist the desired state of a config-backed bot. |
| `restart(id, { recreate? })` | Stop and start again. `recreate: true` rebuilds a config-backed bot through the factory (fresh provider). |
| `startAll()` / `stopAll()` | Run in parallel and never throw: `Record<id, 'ok' \| Error>`. |
| `shutdown()` | Cancels pending reconnects and stops every bot **without** changing the persisted desired state, so `restore()` brings them back. |
| `connection(id)` | `{ state, reason?, authPayload?, updatedAt? }`. `state` is `connecting`, `authenticating`, `ready`, `closed` or `unknown`. `authPayload` is the QR string or pairing code while authenticating: treat it as a secret. |
| `metrics(id)` | `{ id, running, connection, startedAt?, uptimeMs, messagesIn, errors, starts, restarts, reconnectAttempts, activeConversations?, flows? }`. The last two appear only when the bot exposes `listConversations()` / `listFlows()`. |

Events (typed through `ManagerEventMap`):

| Event | Payload |
| --- | --- |
| `added`, `removed`, `started`, `stopped`, `restarted` | `id` |
| `error` | `{ id, error }` (a default no-op listener prevents crashes) |
| `connection` | `{ id, state, reason?, ... }` for bots that emit `connection` |
| `reconnecting` | `{ id, attempt, delayMs, reason }` |
| `reconnected` | `{ id, attempts }` |
| `reconnectFailed` | `{ id, attempts, error? }` |

Logging goes through pino at `debug`/`warn`: inject a logger
(`new BotManager({ logger })`) or set `BOTWA_MANAGER_LOG_LEVEL=debug`
(default `silent`).

## Multi-tenant persistence

A bot created with `createBot()` is backed by a `BotConfigRecord`: `id`,
`tenantId`, `name?`, `provider?: { type, options? }`, `flows?` (JSON flow
documents), `meta?`, `desiredState` (`running` | `stopped`), `version`,
`createdAt` and `updatedAt`. The `provider` block is opaque to the manager: your
`factory(config)` interprets it.

| Method | Notes |
| --- | --- |
| `createBot({ id?, tenantId?, name?, provider?, flows?, meta?, autoStart? })` | Builds the bot through the factory, registers it, persists the config and starts it (`autoStart` defaults to `true`). A failed start is reported through `error`; it does not reject. |
| `updateBot(id, patch, { expectedVersion? })` | Patches `name`, `provider`, `flows`, `meta` or `desiredState`. Changing `provider` or `flows` rebuilds the bot. `expectedVersion` gives optimistic concurrency (`CONFLICT` on mismatch). |
| `deleteBot(id)` | Stops, unregisters and deletes the persisted config. |
| `restore()` | Call once at boot: rebuilds every stored bot and starts those whose desired state is `running`. Returns `Record<id, 'started' \| 'stopped' \| Error>`. |
| `getConfig(id)` / `listConfigs(tenantId?)` | Copies of the stored records. |

Bot and tenant ids must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` (they become
file names). Bots created without a tenant use `defaultTenantId`
(`'default'`).

Storage is pluggable through `BotConfigStore` (`list`, `get`, `put`,
`delete`):

- `persistence: { dir }` is shorthand for
  `configStore: new FileBotConfigStore({ dir })`: one JSON file per bot under
  `<dir>/<tenantId>/<botId>.json`, atomic writes, mode `0600` (directories
  `0700`). Unparseable files are skipped, never deleted (`onCorrupt` receives
  them).
- `MemoryBotConfigStore` keeps configs in RAM (tests). Without a store nothing
  is persisted and `restore()` throws `NOT_CONFIGURED`.

::: warning Secrets
`provider.options` is written to disk as is. Store a reference (an env var
name, a `SecretVault` ref) and resolve it inside the factory.
:::

## Supervision and reconnect

With `autoReconnect`, the manager supervises every bot you asked to run:

- when a bot emits `connection: closed` (except `sessionTakenOver`) and the
  provider does not recover on its own within `graceMs`, or
- when a start fails,

it restarts the bot with backoff and jitter until `maxRetries` is exhausted.
Config-backed bots are recreated through the factory (fresh provider). A
manual `stop()` cancels the supervision.

| Option | Default |
| --- | --- |
| `enabled` | `true` when an object is given (`autoReconnect: true` uses all defaults) |
| `maxRetries` | `5` (`Infinity` never gives up) |
| `initialDelay` / `maxDelay` | `1000` / `30000` ms |
| `backoff` / `factor` | `'exponential'` (or `'linear'`) / `2` |
| `jitter` | `0.2` (each delay lands in 80–100 % of its value) |
| `graceMs` | `10000` |

`computeBackoff(attempt, opts)` and `resolveAutoReconnect(input)` are exported
for custom supervisors.

## Core dynamic flow registry

The manager drives these `Bot` methods from `@botmesh/core`; you can use them
directly in any bot:

| Method | Behavior |
| --- | --- |
| `bot.registerFlow(flow)` | Registers a `FlowBuilder` or `CompiledFlow` at runtime and returns its id. Throws if the id already exists. |
| `bot.replaceFlow(id, flow)` | Hot-swaps (or registers) the flow under `id`; its trigger replaces the old one. Running conversations keep the version they entered with; persisted checkpoints resume on the new steps by step index. |
| `bot.unregisterFlow(id)` | Removes a flow or conversation; its triggers stop matching. `false` when unknown. |
| `bot.hasFlow(id)` | Whether a flow or conversation is registered under `id`. |
| `bot.listFlows()` | `RegisteredFlowInfo[]`: `{ id, kind: 'flow', steps, persistent }` or `{ id, kind: 'conversation' }`. |
| `bot.triggerFlow(id, { chatId, userId?, isGroup? }, { data?, body? })` | Starts a flow proactively in a chat. Returns `Promise<boolean>`. |
| `bot.listConversations()` | `ConversationSnapshot[]`: `{ key, state, waiting, queued, accepts? }`. |
| `bot.abortConversation(key)` | Aborts a live conversation by key. |

`triggerFlow()` is a thin wrapper over `bot.trigger()` with
`ifActive: 'replace'`: it goes through the same access-list and handoff gates,
the chat's FIFO slot, language resolution and metrics, and replaces a
conversation already running (or dormant) on the same key. `data` is
shallow-merged into `c.state` (the same option as `bot.trigger()`; `state` is
a deprecated alias, and passing both throws a `TypeError`); `body` becomes
`ctx.body` of the synthetic message (default `''`). It resolves `false` when the flow is unknown, the
subject is blocked by the access lists or the chat is handed off, and rejects
when the bot is not started.

```ts
import { flow } from '@botmesh/core'

bot.registerFlow(flow('survey').ask('Your name?', 'name').say((_ctx, c) => `Thanks ${c.state.name}`))
await bot.triggerFlow('survey', { chatId }, { data: { source: 'campaign' } })
```

## JSON flows

A flow document is pure data, so it is safe to accept over the API and to
persist. `compileFlowDocument(doc)` validates it and returns a `CompiledFlow`
for `bot.registerFlow()` / `bot.replaceFlow()`; it throws `FlowDocumentError`
(with `issues: { path, message }[]`) when the document is invalid.
`validateFlowDocument(doc)` returns the issues without throwing, and
`isFlowDocument(doc)` is a type guard.

```json
{
  "version": 1,
  "id": "survey",
  "trigger": { "keywords": ["survey", "poll"], "match": "equals", "scope": "dm" },
  "timeout": "10m",
  "steps": [
    { "kind": "ask", "text": "Your name?", "stateKey": "name",
      "validate": { "expr": "len($answer) > 1", "message": "Too short, try again" } },
    { "kind": "choose", "text": "Plan for {{ name }}?", "stateKey": "plan",
      "options": [{ "key": "pro", "label": "Pro" }, { "key": "max", "label": "Max" }] },
    { "kind": "condition", "if": "oneOf(plan, \"pro\", \"max\")",
      "then": [{ "kind": "say", "text": "Great choice, {{ name }}" }],
      "else": [{ "kind": "end", "text": "Bye" }] }
  ]
}
```

| Field | Notes |
| --- | --- |
| `version` | Always `1`. |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$` (same pattern for `stateKey`, option `key` and `goto` targets). |
| `trigger` | A keyword, an array of keywords, or `{ keywords, match?: 'equals' \| 'contains' \| 'startsWith' \| 'endsWith', scope?: 'dm' \| 'group' \| 'all' }`. |
| `timeout` | Milliseconds or `'500ms'`, `'30s'`, `'5m'`, `'1h'` (at most 7 days). |
| `persistent` | Survives restarts with a persistent store. |
| `name`, `description` | Free text. |

Steps:

| `kind` | Fields |
| --- | --- |
| `say` | `text` |
| `ask` | `text`, `stateKey`, `timeout?`, `retries?` (0–20), `validate?: { expr, message? }` (`$answer` holds the raw answer) |
| `choose` | `text`, `options: [{ key, label, steps? }]` (up to 20; an option's `steps` run when it is picked), `stateKey?`, `timeout?` |
| `delay` | `duration` (at most 5 minutes) |
| `goto` | `target` (another flow id) |
| `end` | `text?` |
| `condition` | `if` (expression), `then` (steps), `else?` (steps) |

Texts accept `{{ path }}` placeholders over `c.state` and `$body`, `$from`,
`$sender`, `$isGroup`. Expressions (`condition.if`, `ask.validate.expr`) use a
small safe language parsed at compile time (no `eval`, no regexes): literals,
state paths, `== != < <= > >= && || ! + -`, parentheses and the functions
`len`, `lower`, `upper`, `trim`, `number`, `string`, `contains`, `startsWith`,
`endsWith`, `empty`, `oneOf`.

Limits (`FLOW_DOCUMENT_LIMITS`): 500 steps, nesting depth 8, 4096 characters
per text, 20 options, 50 keywords, expressions up to 1000 characters. The JSON
Schema (draft 2020-12) is exported as `FLOW_DOCUMENT_SCHEMA` and served at
`GET /v1/flows/schema`.

On a managed bot use `manager.addFlow(botId, doc)`, `manager.putFlow(botId,
flowId, doc)` (create or hot-swap; the document `id` must match),
`manager.removeFlow(botId, flowId)` and `manager.listFlowDocuments(botId)`. For
config-backed bots the documents are persisted with the config and registered
again on every rebuild.

## REST API `/v1` (`createRestApi`)

`createRestApi(manager, options)` returns a `(req, res, next?) => void`
handler. Requests outside the prefix call `next()` when given (so it can be
mounted inside another server), or get `404`.

| Option | Default |
| --- | --- |
| `tokens` | **Required** (at least one): `{ id, token, tenantId?, scopes }`. The secret needs 16+ characters (use 32+ random bytes). |
| `prefix` | `'/v1'` |
| `publicDocs` | `true`: `openapi.json` and `flows/schema` need no token (with `false` they need `bots:read`) |
| `maxBodyBytes` | 1 MiB |
| `rateLimit` | Token bucket per token (per client address for anonymous calls): 60 burst, 1 request/s. Pass options, your own `RateLimiter`, or `false`. |
| `idempotency` | In memory, 24 h replay. Pass options, your own `IdempotencyStore`, or `false`. |
| `defaultTenantId` | `'default'` (tenant of bots added without one) |
| `openapi` | `{ title?, version?, servers? }` overrides for the document |
| `allowInsecureMediaUrls` | `false`: `send` only accepts `https:` media URLs |
| `allowPrivateMediaHosts` | `false`: `send` rejects media URLs whose host is or resolves to a loopback/private/link-local address (SSRF) |
| `mediaHostResolver` | DNS resolver used to vet media hosts (tests, egress gateways). Default: the system resolver |

### Authentication and tenants

Send the token as `Authorization: Bearer <token>` or `X-API-Key: <token>`
(compared through SHA-256 digests in constant time). A token without
`tenantId` (or with `'*'`) sees every tenant; a tenant token only sees its own
bots, and any other bot answers `404`. Scopes (`'*'` grants all):

`bots:read`, `bots:write`, `bots:operate`, `connections:read`,
`messages:read`, `messages:send`, `conversations:read`,
`conversations:write`, `flows:read`, `flows:write`, `metrics:read`.

### Routes

All paths are relative to the prefix.

| Route | Scope | Success |
| --- | --- | --- |
| `GET /health` | public | `200 { status, uptimeMs }` |
| `GET /openapi.json` | public (see `publicDocs`) | `200` OpenAPI 3.1 document |
| `GET /flows/schema` | public (see `publicDocs`) | `200` flow document JSON Schema |
| `GET /metrics` | `metrics:read` | `200 { bots, running, messagesIn, items }` |
| `GET /bots?tenantId=` | `bots:read` | `200` list of bots |
| `POST /bots` | `bots:write` | `201` bot detail (needs a `factory`) |
| `GET /bots/{botId}` | `bots:read` | `200` status, connection state and config (secret-looking keys of `provider` and `meta` redacted) |
| `PUT /bots/{botId}` | `bots:write` | `200` (`expectedVersion` → `409` on mismatch) |
| `DELETE /bots/{botId}` | `bots:write` | `204` |
| `POST /bots/{botId}/start`, `/stop`, `/restart` | `bots:operate` | `200` new status |
| `GET /bots/{botId}/connection` | `connections:read` | `200` state plus the QR / pairing payload |
| `POST /bots/{botId}/send` | `messages:send` | `200 { messageId?, chatId, skipped? }` |
| `GET /bots/{botId}/messages?chatId=&limit=&cursor=` | `messages:read` | `200 { data, nextCursor }`, newest first, `limit` 1–200 (default 50) |
| `POST /bots/{botId}/trigger` | `conversations:write` | `202 { started: true }` |
| `GET /bots/{botId}/conversations` | `conversations:read` | `200` live conversations |
| `POST /bots/{botId}/conversations/{key}/cancel` | `conversations:write` | `200 { cancelled: true }` |
| `GET /bots/{botId}/metrics` | `metrics:read` | `200` bot counters |
| `GET /bots/{botId}/flows` | `flows:read` | `200 { registered, documents }` |
| `POST /bots/{botId}/flows` | `flows:write` | `201 { id }` |
| `GET /bots/{botId}/flows/{flowId}` | `flows:read` | `200` stored document |
| `PUT /bots/{botId}/flows/{flowId}` | `flows:write` | `201` created / `200` replaced |
| `DELETE /bots/{botId}/flows/{flowId}` | `flows:write` | `204` |

Request bodies:

- `send`: `{ chatId, text }` or `{ chatId, content }`. `content` is an
  allowlisted subset of `OutboundContent`: `text`, `image`, `video`, `audio`,
  `voice`, `document`, `sticker` (media only as `{ url: "https://..." }`, no
  paths or buffers), `location`, `contact` and `poll` (2–12 options).
- `trigger`: `{ flowId, chatId, userId?, isGroup?, state? }` (`state` up to
  16 KiB of JSON). It calls `bot.triggerFlow()`: `404` when the flow is
  unknown, the subject is blocked or the chat is handed off; `409
  BOT_NOT_RUNNING` when the bot is stopped.
- `POST /bots`: `{ id?, tenantId?, name?, provider?, flows?, meta?, autoStart? }`.
  A tenant token can only create bots in its own tenant.

```bash
H="Authorization: Bearer $ACME_TOKEN"
curl -H "$H" localhost:3000/v1/bots
curl -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: send-42' \
  -d '{"chatId":"573001234567","text":"Hello"}' localhost:3000/v1/bots/support/send
```

### Responses and status codes

Successful responses are `{ data, requestId }` (the OpenAPI document and the
flow schema are returned as is). Errors are
`{ error: { code, message, requestId, details? } }`. Every response carries
`X-Request-Id` (a valid incoming one is echoed), `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. While rate limiting is on (the default),
every route, public ones included, is limited and adds `RateLimit-Limit` and
`RateLimit-Remaining`.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `VALIDATION_FAILED`, `INVALID_JSON`, `BAD_REQUEST` | Invalid body, query or path (flow issues in `details`) |
| `401` | `UNAUTHORIZED` | Missing or unknown token (`WWW-Authenticate: Bearer`) |
| `403` | `FORBIDDEN` | Missing scope, or cross-tenant `tenantId` |
| `404` | `NOT_FOUND` | Unknown route, bot (or a bot of another tenant), flow or conversation |
| `405` | `METHOD_NOT_ALLOWED` | Known path, wrong method (`Allow` header) |
| `409` | `CONFLICT`, `BOT_NOT_RUNNING` | Duplicate id or flow, version mismatch, trigger on a stopped bot |
| `413` | `PAYLOAD_TOO_LARGE` | Body over `maxBodyBytes`, or content over a provider limit |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Body is not `application/json` |
| `422` | `IDEMPOTENCY_KEY_REUSED`, `UNSUPPORTED_CONTENT`, `RECIPIENT_UNREACHABLE`, `OUTSIDE_SESSION_WINDOW` | Key reused with another request, or the provider refused the send |
| `429` | `RATE_LIMITED` | Rate limit hit (`Retry-After`) |
| `500` | `INTERNAL`, `LIFECYCLE_FAILED` | Unexpected error, or start/stop/restart failed |
| `501` | `NOT_SUPPORTED`, `NOT_CONFIGURED` | The bot lacks the capability, or the manager has no factory/store |
| `502` | `SEND_FAILED` | The provider failed to send |
| `503` | `UPSTREAM_RATE_LIMITED` | The provider rate-limited the send (`Retry-After`) |

### Idempotency

Mutating routes accept `Idempotency-Key` (1–200 visible ASCII characters).
Keys are scoped per token. Repeating a request with the same key, method, path
and body replays the stored response (header `Idempotent-Replayed: true`);
reusing the key for a different request is `422 IDEMPOTENCY_KEY_REUSED`. 5xx
outcomes are not stored, so they can be retried. The default
`MemoryIdempotencyStore` and `TokenBucketRateLimiter` live in process memory:
plug your own `IdempotencyStore` / `RateLimiter` when running several
instances.

### OpenAPI document

The OpenAPI 3.1 document is generated from the same route table the router
uses (`ROUTES`), so it cannot drift from the implementation. Get it from a
running server:

```bash
curl localhost:3000/v1/openapi.json > openapi.json
```

or build it in code, without a server:

```ts
import { buildOpenApiDocument } from '@botmesh/manager'

const doc = buildOpenApiDocument({ title: 'Bots API', servers: ['https://bots.example.com'] })
```

`buildOpenApiDocument({ prefix?, title?, version?, servers? })` defaults to
`'/v1'`, `'botmesh Manager API'`, `'1.0.0'` and a relative server. It declares
both security schemes (`bearerAuth` and `apiKey` through `X-API-Key`) and an
`x-required-scope` per operation.

## Other HTTP surfaces

### `createControlPlaneApi`

A minimal audited surface with tenant-bound API keys. It also defaults to the
`/v1` prefix, so do not mount it next to `createRestApi` on the same prefix.

```ts
import { BotManager, createControlPlaneApi } from '@botmesh/manager'

createServer(createControlPlaneApi(manager, {
  tenantId: 'acme',
  apiKeys: [{ id: 'ops', tenantId: 'acme', secret: process.env.MANAGER_KEY!, scopes: ['bots:read', 'bots:operate', 'audit:read'] }],
})).listen(3000)
```

- It requires `tenantId` and at least one key; there is no anonymous mode.
  Keys go in `X-API-Key` or `Authorization: Bearer <key>`.
- Routes: `GET /v1/health` and `GET /v1/bots` (`bots:read`),
  `POST /v1/bots/:id/start` and `POST /v1/bots/:id/stop` (`bots:operate`),
  `GET /v1/audit` (`audit:read`).
- Responses are `{ data, requestId }`; errors are `{ error: { code, requestId } }`
  with `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`
  (an `Idempotency-Key` reused for another request) and `500 INTERNAL`.
- Health, list and start/stop calls, and every denied or unknown-bot request
  of an authenticated key, are written to an `AuditLog` (in memory; pass your
  own through `auditLog`). Metadata keys that look like tokens, secrets,
  passwords or API keys are redacted.

Related building blocks: `SecretVault` (AES-256-GCM, 32-byte master key;
`put` returns only `{ ref, version }`), `IdempotencyRegistry`,
`assertAuthorized` and `verifyApiKey` (constant-time comparison).

### Desired state reconciler

`MemoryDesiredStateStore` and `BotReconciler` separate the desired state
(`running` / `stopped`) from the observed state. `reconcile(tenantId, botId)`
starts or stops a bot only when needed; `reconcileTenant(tenantId)` does it for
every bot of a tenant. Writes use compare-and-set versions
(`DesiredStateConflictError`), so competing updates cannot silently overwrite
each other. Replace the memory store with a durable `DesiredStateStore` before
running more than one process.

### Legacy `createManagerApi`

`createManagerApi(manager, { prefix?, auth?: { token, header? } })` keeps the
original compact API: `GET {prefix}/health`, `GET {prefix}/metrics`
(Prometheus text), `GET {prefix}/bots`, `GET {prefix}/bots/:id`,
`POST {prefix}/bots/:id/start` and `POST {prefix}/bots/:id/stop`. Without
`auth` it is **unauthenticated** and logs a one-time warning; always set a
token. A failed start/stop answers `500 { "error": "start failed" }` (the
error itself goes to `onError(error, { id, action })`, never to the client).
Prefer `createRestApi` for new deployments.

## See also

- [`@botmesh/manager` README](https://github.com/andresayac/botmesh/tree/main/packages/manager)
- [Operations](/guide/operations)
- [Golden transcripts](/guide/golden-transcripts): gate deployments on recorded conversations
