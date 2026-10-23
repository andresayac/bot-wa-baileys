# @botmesh/events

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

Dependency-free primitives to process async work reliably: versioned envelopes, idempotency, leases, retries with backoff and a dead-letter queue (DLQ).

```ts
import { createEnvelope, EventWorker, MemoryEventJournal } from '@botmesh/events'

const journal = new MemoryEventJournal()
const event = createEnvelope({
  eventType: 'message.received',
  context: {
    tenantId: 'acme', environmentId: 'production', botId: 'support',
    providerId: 'meta', connectionId: 'main', chatId: '573001234567',
  },
  payload: { text: 'hello' },
})

await journal.append(event)
const worker = new EventWorker(journal, { maxAttempts: 5, leaseMs: 30_000 })
worker.on('message.received', async (received) => {
  console.log(received.payload)
})

const { processed, failed, stale } = await worker.runBatch()
```

### Leases and fencing tokens

Each `claim` returns a strictly increasing `fencingToken` per event (never reused, not even after `replay`). `EventWorker` returns it in `ack`/`fail`, and the journal rejects a superseded token with `StaleLeaseError`. So if a worker's lease expires while its handler is still running and another worker claims the event, the first can no longer mark it done, retry it or send it to the DLQ: `runBatch()` counts it as `stale`. It also skips a record whose lease expired before its handler started and returns it with `release()`, which does not consume the attempt: skipping it never moves it closer to the DLQ.

Delivery is still *at-least-once*: a handler may run twice, so make it idempotent (use `envelope.idempotencyKey`). Calling `ack`/`fail` without `fencingToken` is an operator override with no check. A custom `EventJournal` adapter must check the token in the same atomic operation that changes state (e.g. `UPDATE ... WHERE fencing_token = $1 AND state = 'processing'`).

For tests, inject the clock: `new EventWorker(journal, { clock: () => now })`.

`MemoryEventJournal` is for development and tests. The `EventJournal` interface lets you implement durable adapters over Redis, PostgreSQL or an external broker without changing the workers.

For a single instance there is also `FileEventJournal.open('./data/events.json')`: it recovers the snapshot after a restart and writes with atomic replacement. It is not safe for several processes at once; use `SharedFileEventJournal` (below) or a database adapter for that.

### Bot durability backend (`@botmesh/events/durability`)

If your app already uses an event journal, it can also serve as the bot's [durability](../../docs/es/guide/durabilidad.md) backend (`BotConfig.durability`), without another store:

```ts
import { Bot } from '@botmesh/core'
import { FileEventJournal } from '@botmesh/events'
import { eventsDurability } from '@botmesh/events/durability'

const journal = await FileEventJournal.open('./data/events.json', { lock: true })
const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
// …
await bot.stop()
await journal.close()
```

- **Inbox:** every inbound bot message is stored as an `EventRecord` in the journal (`eventType: 'botwa.inbound.message'`, channel `'botwa:durable'`), with its leases and fencing tokens. `list()` and `replay()` see them; an `EventWorker` **never** claims them, because a `claim` without `channel` only takes records without a channel. The bot itself processes those records (FIFO per chat, causality, ack on settle).
- **Outbox:** the core outbox state machines over a key-value store saved as a *sidecar* of the same journal: same file and same atomic snapshot as the inbox. The file moves to `version: 2` as soon as a sidecar exists; a process that only uses events rewrites it keeping that sidecar.
- `FileEventJournal` needs `{ lock: true }`: an advisory lock (`<file>.lock` with the pid) prevents two processes from using the same file; a dead process's lock is taken over. No process is ever killed. Within one process, a second `open(path, { lock: true })` of the same file is rejected until `close()` is called on the first; after `close()`, writes reject.
- Cost: `FileEventJournal` rewrites the whole file on every write (app events + bot records during retention + outbox). Concurrent writes share a single rewrite and `extend()` (the lease heartbeat) only changes memory: it is written with the next change or on `close()`. With high traffic, use a dedicated file for the bot, a short retention or a database `outbox`.
- Multiple replicas need a shared `LeasedEventJournal` with atomic operations and fencing. **`SharedFileEventJournal.open(path, { lockTimeoutMs?, staleLockMs? })`** is that for several processes on the same host: every write takes a cross-process mutex (`<file>.mutex` with `<pid>:<nonce>`), re-reads the file, applies the operation and replaces it atomically, so claims are exclusive and fencing tokens hold across processes; `extend()` is also written (other processes must see the heartbeat). The outbox lives in the same file (`readSidecar`/`updateSidecar`, no `sidecar()`), shared by all. A dead process's mutex is broken immediately and one held longer than `staleLockMs` (30 s) is considered abandoned; nothing is killed. Same format as `FileEventJournal`, but never both at once (a file with a live `FileEventJournal` is rejected). It rewrites the whole file on every write: for high traffic, use another `LeasedEventJournal` with a shared outbox (a Postgres or Redis `DurableKv`).

`LeasedEventJournal` (implemented by `MemoryEventJournal`, `FileEventJournal` and `SharedFileEventJournal`) adds these atomic operations to `EventJournal`: `appendRecord` (optionally already claimed), `claimOne`, `extend`, `purge`, and `claim` with `owner`/`reclaimOwn`/`channel`/`filter`/`order`. It also adds `fail` with explicit `dead`/`retryAt`, `release` with `toPending` and `sidecar()` (or, in multi-process journals, `readSidecar()`/`updateSidecar()`). Existing calls behave the same.
