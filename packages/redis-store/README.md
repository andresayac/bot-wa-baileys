# @bot-wa/redis-store

> [!WARNING]
> **Experimental — aún no publicado en npm.** Forma parte de la primera alpha, pero todavía no hay nada en npm: hasta entonces úsalo desde este monorepo (`workspace:*`); el `pnpm add` de abajo funcionará cuando se publique. La API puede cambiar sin aviso. Está probado contra un Redis real (ver [Tests de integración](#tests-de-integración)).

Redis [`IStore`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core) implementation for **@bot-wa/core** — distributed, shared bot state backed by Redis (node-redis v4). Point any number of bot replicas at the same Redis instance and they share message logs, chats, contacts, flow checkpoints, AI conversation history and delivery cursors.

- Per-chat message logs as Redis **sorted sets** (score = timestamp) → `getMessagesByChat(limit)` is an `O(log N + limit)` `ZRANGE`, not a scan.
- Everything is JSON under one configurable **prefix**, so apps/bots can share a database.
- Optional **TTL** for ephemeral session state (conversations, checkpoints).
- Injectable client → fully hermetic unit tests (an in-memory fake ships with the test-suite; no real Redis needed), plus an opt-in suite against a real server.
- **`RedisCoordinator`** for running N replicas of one bot (`BotConfig.coordination`): per-chat turns in ingress order across replicas, and leader election for exclusive transports (Baileys).
- **Fenced lock** helpers (`acquireLockFenced` / `renewLock` / `releaseLock`) for your own critical sections.

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
  sessionTtl: '7d',                // optional: expire conversations/checkpoints after 7 days
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
client.on('error', (err) => logger.error({ err }, 'redis client error')) // required, see below
await client.connect()

const store = new RedisStore({ client })   // no url needed
```

node-redis **re-throws an `'error'` event that has no listener**, so an injected client without one crashes the process on the first dropped connection. The store attaches that listener only to the client it creates itself.

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
| `sessionTtl` | `string \| number` | —                   | TTL for AI conversations and flow checkpoints: a duration (`'24h'`, `'7d'`) or **milliseconds**, like every duration option of `@bot-wa/core`. Messages, chats, contacts and cursors never expire — delete them explicitly. An invalid duration or a non-positive value throws from the constructor. |
| `ttl`    | `number`          | —                         | **Deprecated**, use `sessionTtl`. Same TTL in **seconds** (fractions allowed). Setting both throws a `RangeError`. |
| `maxMessagesPerChat` | `number` | — (unbounded)       | Keep only the newest N messages per chat; `saveMessage` prunes older ZSET members **and** their item keys. Must be a non-negative integer (else `RangeError`). |
| `logger` | `{ error? }`    | —                         | Receives the errors of a store-created client (connection drops, failed reconnects) and lifecycle errors (e.g. close failure). |

## Key scheme

| Key | Type | Contents | TTL |
| --- | ---- | -------- | --- |
| `{prefix}:msg:{chatId}` | ZSET | `messageKey(ref)` → timestamp (per-chat index) | — |
| `{prefix}:msg:item:{messageKey}` | string (JSON) | `StoredMessage` (`messageKey` = `{chatId}:{id}`, `:` and `%` escaped) | — |
| `{prefix}:chat:{id}` | string (JSON) | `StoredChat` | — |
| `{prefix}:contact:{id}` | string (JSON) | `StoredContact` | — |
| `{prefix}:cp:{key}` | string (JSON) | `FlowCheckpoint` | `sessionTtl` |
| `{prefix}:conv:{key}` | string (JSON) | `AIMessage[]` | `sessionTtl` |
| `{prefix}:cursor:{key}` | string | delivery cursor (e.g. Telegram `update_id`) | — |
| `{prefix}:lock:{key}` | string | lock token (`SET NX PX`) | lock `ttlMs` |
| `{prefix}:sched:{id}` | string (JSON) | durable scheduler task (`ScheduleRecord`, see `schedules()`); a deleted task leaves a small `{ deleted, fencingToken }` marker so its tokens never go backwards | — |
| `{prefix}:lease:{key}` | string (JSON) | fenced lease (owner, deadline, token; see `leases()`) | — |

`getMessagesByChat(chatId, limit)` reads the latest `limit` entries from the ZSET (`ZRANGE … BYSCORE REV LIMIT`) and fetches the JSON items, returning them oldest→newest — same windowing semantics as `@bot-wa/sqlite-store`.

`deleteChat(chatId)` runs as **one Lua script** (the ZSET, every item it lists and the chat record), so a message saved at the same moment either lands before the delete (and goes with it) or after it (and survives intact) — never as an orphan item missing from the chat's log. `deleteMessage` removes an item only when it is a member of that chat's ZSET. Scripts touch keys they compute from the prefix, so the store targets a single Redis node (not Redis Cluster).

- **Message keys.** `messageKey(ref)` (from `@bot-wa/core`) is `{chatId}:{id}` with `%` and `:` percent-escaped in each part (`%25`, `%3A`), so ids that contain `:` — Twilio's `whatsapp:+1…` chat ids — never collide (`('a:b', 'c')` and `('a', 'b:c')` used to share the key `a:b:c`). Ids without `:` or `%` keep exactly the key earlier versions wrote. Rows written by an earlier version under the old unescaped key are still read and deleted (a fallback that only runs for ids containing `:` or `%`, and only returns or deletes a row whose stored `ref` is that very message, since a legacy key can be another message's new key), and re-saving such a message moves it to the new key — no manual migration. One theoretical edge remains: an id that literally contains `%3A` and was stored by an earlier version can be overwritten by a new message whose id has `:` in the same place.

## Running N replicas: `RedisCoordinator`

```ts
const store = new RedisStore({ url: process.env.REDIS_URL, prefix: 'mybot' })
const bot = new Bot({
  provider,
  store,
  coordination: { coordinator: store.coordinator({ leaseMs: '15s' }) }, // or new RedisCoordinator({ url, prefix })
})
```

- **Chat turns.** Each inbound message reserves a ticket in its chat's queue (`INCR`); a Lua compare-and-set hands the chat's turn to the tickets in order, so the replicas process a chat one at a time and in ingress order. Tickets of a replica whose heartbeat expired are skipped.
- **Leadership.** `tryLead(name)` / `lead(name)`: a `PX` lease plus an `INCR` term (a fencing token that grows every time the leadership changes hands). The bot uses `provider:<id>` to connect an exclusive transport on one replica only.
- **Watchdog.** Heartbeat, turns and leaderships are renewed every `leaseMs / 3`. A lease found gone aborts its `signal` (`'expired'`); with no successful renewal for 90% of `leaseMs`, every lease is given up locally (`'coordinator-down'`) before Redis can hand it to another replica.
- Keys live under `{prefix}:co:`; a chat's counters expire `idleTtlMs` (default 1 day) after its last turn.
- Limits: one Redis primary (standalone or Sentinel; a failover that loses the last writes can grant a lease twice). Redis Cluster is not supported.
- Guide: [Running N replicas](../../docs/guide/replicas.md).

## Distributed lock

`RedisStore` also exposes a lock for your own critical sections (the bot coordination above does not use it).

```ts
const lock = await store.acquireLockFenced(`report:${day}`, 30_000) // SET NX PX + INCR fence
if (!lock) return // another replica holds it

try {
  await writeReport(day, { fence: lock.fence }) // the resource rejects fences lower than the last it saw
  await store.renewLock(`report:${day}`, lock.token, 30_000) // extend a long section
} finally {
  await store.releaseLock(`report:${day}`, lock.token) // Lua compare-and-delete
}
```

- `acquireLockFenced(key, ttlMs = 30_000)` → `{ token, fence }`, or `null` when held. `fence` grows by one on every acquisition of `key` and never resets.
- `renewLock(key, token, ttlMs = 30_000)` → `true` while `token` still owns the lock (atomic), `false` once it expired or changed hands.

The older `acquireLock` (below) keeps working unchanged but has no fence; it is deprecated in favour of `acquireLockFenced`.

```ts
const token = await store.acquireLock(`chat:${chatId}`, 30_000) // SET NX PX
if (!token) return // another replica holds it

try {
  await processChat(chatId)
} finally {
  await store.releaseLock(`chat:${chatId}`, token) // Lua compare-and-delete
}
```

- `acquireLock(key, ttlMs = 30_000)` → opaque token on success, `null` when already held. The `PX` deadline guarantees a crashed holder never wedges the fleet. `ttlMs` must be a positive finite number (fractions are rounded up); anything else rejects with a `RangeError`.
- `releaseLock(key, token)` → `true` only if the token still owns the lock. Release is an atomic Lua compare-and-delete, so a slow holder can never delete a newer owner's lock.

## Durable scheduler tasks

`store.schedules()` is a `ScheduleStore` for durable `bot.schedule/every/delay` tasks (tasks registered with an `id`; see the scheduler guide), and `store.leases()` a fenced `LeaseProvider` for scheduler leadership. Both share the store's client and prefix.

```ts
const store = new RedisStore({ url: process.env.REDIS_URL })
const bot = new Bot({ provider, store, scheduler: { store: store.schedules(), lease: store.leases() } })
bot.every('15m', { id: 'sync-crm', missed: 'run-once' }, async (run) => { /* run.occurrenceKey */ })
```

Every mutation is a compare-and-set on the task's JSON key (the same script as the upserts), so of N replicas claiming one occurrence exactly one wins, with a fencing token that only grows. Lease deadlines use the replicas' clocks: keep them in sync (NTP). `RedisScheduleStore` and `RedisLeaseProvider` can also be built on any client: `new RedisScheduleStore({ client, prefix })`.

Unlike `acquireLock`, `leases()` grants carry a monotonic fencing token, and `acquire` by the current holder extends the lease.

## Notes

- Designed for **distributed state**: multiple bot replicas sharing one Redis get a consistent view of history, checkpoints and cursors.
- Listing (`listChats` / `listContacts` / `listCheckpoints`, and the `ctx.user` list/namespace deletes) walks `{prefix}:…:*` with incremental `SCAN` (node-redis' `scanIterator`), so a large keyspace on a shared server is never blocked by one `KEYS` command; an injected client without `scanIterator` falls back to `KEYS`. The matching records are then fetched with parallel (pipelined) `GET`s. Glob metacharacters in the prefix (`*`, `?`, `[`, `]`, `\`) are escaped, so a prefix like `bot[1]` never lists another prefix's keys.
- `getMessagesByChat(chatId, limit)` accepts any number, like `MemoryStore`: `0`, negative or `NaN` → `[]`, fractions round up, `Infinity` → the whole log.
- `maxMessagesPerChat` pruning is safe with several replicas writing the same chat at once: each trim removes only what is beyond the newest N at that instant, so it can never cut into the newest N.
- `upsertChat` / `upsertContact` shallow-merge exactly like `MemoryStore` (`{ ...existing, ...patch }`; an explicit `undefined` removes the field). The write is an atomic compare-and-set on the server (a small Lua script): if another replica changed the record between the read and the write, the store re-reads and merges again, so concurrent upserts from **any number of replicas** never lose each other's fields. The merge runs in JS, not in Lua, so values are stored byte-exact (a server-side cjson round-trip would turn `[]` into `{}` and cut numbers to 14 digits). Under pathological contention an upsert gives up after 50 attempts with an error.
- Do not inject a client configured with `returnBuffers: true`; the store expects string replies.
- Lifecycle of a **self-created** client (an injected one is never connected, quit or listened to):
  - `start()` is idempotent (concurrent calls share one connect) and rejects promptly with the socket error (e.g. `ECONNREFUSED`) if the server is unreachable; call it again to retry.
  - Once connected, a dropped connection is logged through `logger.error` and retried with backoff (0–500 ms) instead of crashing the process.
  - `stop()` is idempotent and never hangs: it sends `QUIT` (pending replies still arrive), disconnects immediately if the client is offline, and gives up waiting for the `QUIT` reply after 2 s.

## Tests de integración

Los tests unitarios (`tests/redis-store.test.ts`, `tests/conformance.test.ts`, `tests/fakeRedis.test.ts`) usan un cliente falso en memoria (`tests/fakeRedis.ts`) que imita la semántica de Redis para los comandos que envía el store: glob de `KEYS` byte a byte (escapes con `\`, clases `[...]`), `ZRANGE` por rango o por score, validación de `EX`/`PX` y `LIMIT`, `WRONGTYPE`, `MULTI` sin rollback y `EVAL` solo de los scripts del store. Esas expectativas viven en `tests/redis-probes.ts` y `tests/integration.test.ts` las verifica también contra un servidor de verdad, junto con:

- la suite compartida de conformidad de `IStore` (con cliente inyectado y con cliente propio del store);
- las mismas sondas (`redis-probes.ts`) que usa el fake, para que no se aleje del servidor real;
- ciclo de vida: `start()` idempotente (también en paralelo), persistencia tras `stop()`/`start()` con una instancia y una conexión nuevas, reinicio de la misma instancia, servidor inalcanzable al arrancar, conexión cortada (vía un proxy TCP local) sin tumbar el proceso, y `stop()` que no se cuelga;
- log de mensajes: orden y `limit` de `getMessagesByChat` (inserción desordenada, límite por defecto, `Infinity`, fracciones, `0`, negativos), timestamps repetidos, `deleteMessage`, `deleteChat` purgando todas las claves, recorte con `maxMessagesPerChat` y `saveMessage` concurrentes desde una y varias conexiones (también recortando a la vez);
- merge superficial de `upsertChat`/`upsertContact` (también concurrente, desde varias conexiones/réplicas a la vez, y sin alterar los valores JSON), unicode/emoji en claves y valores, JSON de varios MB y prefijos con metacaracteres de glob;
- `ttl` (comprobado con `PTTL`, también fraccionario) y el lock distribuido (exclusivo entre conexiones, `PX`, solo el dueño libera, expiración).

Es opt-in: se activa con la variable de entorno `BOTWA_TEST_REDIS_URL` y, si no está definida, el archivo se salta entero, así que `pnpm test` sigue siendo hermético (sin red).

```bash
# 1. Un Redis desechable (puerto 56379 para no chocar con uno local)
docker run -d --name botwa-it-redis -p 56379:6379 redis:7-alpine

# 2. Ejecuta la suite contra él
BOTWA_TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm --filter @bot-wa/redis-store test

# 3. Limpieza
docker rm -f botwa-it-redis
```

En PowerShell: `$env:BOTWA_TEST_REDIS_URL = 'redis://127.0.0.1:56379'; pnpm --filter @bot-wa/redis-store test`.

- **Aislamiento:** todas las claves de una ejecución viven bajo `botwa-it:<pid>-<uuid>:…`, con un prefijo distinto por store, y un `afterAll` borra lo que quede de esa ejecución. No se usa `FLUSHDB`: se puede apuntar a un Redis compartido sin pisar datos ni chocar con otra ejecución en paralelo. La URL admite usuario, contraseña y número de base (`redis://user:pass@host:6379/2`).
- **Windows + Docker Desktop:** usa `127.0.0.1` en lugar de `localhost`. `localhost` resuelve primero a `::1` y el reenvío IPv6 de Docker Desktop acepta la conexión TCP pero la corta (`ECONNRESET`), así que los hooks expiran.
- **CI:** esta suite no corre en CI; ejecútala en local con Docker antes de tocar el store.
