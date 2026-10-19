# Running N replicas

By default a bot is **one process**: each chat has a FIFO queue in memory and
the transport is connected once. To run several copies of the same bot (for
availability, rolling deploys or webhook throughput), turn on
**coordination**. The replicas then share a backend (Redis) that decides
which replica processes each chat and which one connects an exclusive
transport such as WhatsApp Web.

Coordination is opt-in. Without `coordination` nothing below runs and the
bot behaves exactly as before.

## When you need it (and when you don't)

| Situation | Replicas? |
| --- | --- |
| One WhatsApp number on Baileys, a restart now and then is fine | No: one process with PM2/Docker restart is simpler |
| Baileys, and you want a warm standby that takes over in seconds | Yes: 1 active + N standbys |
| Cloud API / Messenger / Telegram webhooks behind a load balancer | Yes: every replica takes traffic |
| Rolling deploys with no gap | Yes |

## Setup

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { RedisStore } from '@bot-wa/redis-store'

const store = new RedisStore({ url: process.env.REDIS_URL, prefix: 'shop' })

const bot = new Bot({
  provider: new BaileysProvider({ session: 'shop' }),
  store,                                     // shared state: chats, checkpoints, ctx.user
  coordination: {
    coordinator: store.coordinator({ leaseMs: '15s' }), // same client and prefix as the store
    // turnWaitMs: '2m',        // longest a message waits for its chat's turn
    // settleMs: '1m',          // longest a turn stays held for a running conversation step
    // providerSession: 'auto', // 'leader' | 'shared' | 'auto'
    // providerDownMs: '1m',    // a leader whose transport stays closed this long steps down
  },
})
await bot.start()
```

Every replica runs the same code. Give each one the same `prefix`; the
replica id is a random UUID per process unless you pass `replicaId` (it must
be unique among the running replicas; a pod or host name is fine). Each
coordinator instance adds its own nonce in Redis (`coordinator.incarnation`),
so a replica restarted with the same `replicaId` never inherits the tickets
of the process that died. With your own Redis connection use
`new RedisCoordinator({ url, prefix })` instead of `store.coordinator()`.

## What you get

**One replica per chat at a time, in order.** When a message arrives, the
replica that received it takes a ticket in that chat's queue in Redis. The
chat's turns go to the tickets in order, whichever replica holds them, and
only one replica holds a chat's turn at a time. So two messages from one chat
are never processed in parallel and are handled in the order they arrived,
even when a load balancer spreads them over replicas. Different chats run in
parallel. In groups the key is per participant, like the conversation scope.

A turn is held until the handler returns **and** the conversation it fed is
waiting again (or has ended), also across a `c.goto()`, so another replica
never sees a flow halfway through a step. `settleMs` bounds that wait: a step
still running then (a slow `.do()`, a long `c.sleep` or delay) is stopped,
keeping its checkpoint, before the turn is released, so it never runs
alongside the replica that takes the chat next. Keep `settleMs` above your
longest step.

A conversation's own timers (its wait timeout, `c.idle()`) also act only
under the chat's turn. If another replica handled the chat meanwhile, the
stale copy is dropped instead of messaging the user or clearing the new
owner's checkpoint.

**Conversations move between replicas through the store.** If the next
message of a `.persistent()` flow reaches another replica, that replica reads
the checkpoint from the store and continues. When the flow was parked on the
first question of its step, the message is taken as that answer (it is not
asked again). Otherwise (a `.do()` step parked on a later question, or a
replica that died before asking) the step runs again from its start, asking
its first question. The replica that had the flow in memory drops its copy
the next time it gets that chat (or when one of its timers fires).

**One connection for exclusive transports.** With `providerSession: 'auto'`
(the default) a provider that declares `capabilities.exclusiveSession` is
started only on the replica elected for `provider:<id>`; the others stand by
and one of them takes over when the leader stops or dies.

| Provider | `exclusiveSession` | With N replicas |
| --- | --- | --- |
| `@bot-wa/baileys` | `true` | 1 connected + standbys |
| `@bot-wa/telegram` (long polling) | `true` | 1 polling + standbys |
| `@bot-wa/telegram` (webhook) | `false` | all receive |
| `@bot-wa/discord` | `true` | 1 gateway + standbys |
| `@bot-wa/meta`, Messenger, Instagram, other webhook providers | unset (`false`) | all receive |

If the leader's transport stays `'closed'` for `providerDownMs` (logged out,
session taken over, reconnect given up), the replica steps down, waits a few
seconds and campaigns again, so a standby can connect meanwhile.

Force it with `providerSession: 'leader'` or `'shared'`. On a standby,
`bot.ready` stays pending (the transport is not connected) and `bot.send()`
rejects with `ProviderNotLeaderError`.

**Failover.** Each replica renews a heartbeat and its leases every
`leaseMs / 3`. When a replica dies, its leases expire after `leaseMs` and the
others carry on: queued tickets of the dead replica are skipped and a
standby connects the transport. When a replica stalls (GC pause, blocked
event loop, lost network) for most of `leaseMs`, it gives its leases up
**before** they can expire in Redis: a send it attempts afterwards rejects
with `LeaseLostError` instead of answering out of order, and its in-memory
conversation for that chat is dropped (the checkpoint stays for the new
owner). A release that fails on the wire (a Redis blip) is repaired by the
watchdog within `leaseMs / 3`, so the chat does not stall behind a live
replica.

## Conversation hand-over

What happens to a chat's live conversation when another replica takes the chat
(the replica that ran it crashed, was stopped for a deploy, froze past its
lease, or cut a step short at `settleMs`):

| Conversation | Default | With `handover` |
| --- | --- | --- |
| `.persistent()` flow | continues from its checkpoint | same |
| flow without `.persistent()` | lost (the message routes as a new one) | `flows: 'forward'`: continues from an ephemeral checkpoint |
| async `bot.conversation`, or a flow that cannot be forwarded | lost | `fallback`: `'notify'`, `'restart'` or your own function |

```ts
const bot = new Bot({
  provider, store,
  coordination: {
    coordinator,
    handover: {
      flows: 'forward',      // checkpoint flows without .persistent() too (TTL-bound)
      fallback: 'notify',    // the rest: tell the user it was interrupted
      ttl: '10m',            // keep above your longest wait timeout
    },
  },
})
bot.on('coordination:handover', ({ key, name, outcome }) => log.info({ key, name, outcome }, 'hand-over'))
```

- **`flows: 'forward'`** writes a checkpoint per step for flows without
  `.persistent()` too, marked ephemeral: it expires `ttl` after its last write
  (default `conversation.timeout`, else 5 minutes) and carries a fingerprint
  of the flow, so a replica running a changed flow (rolling deploy) does not
  resume it at the wrong step; that case goes to `fallback` with
  `reason: 'changed'`. `c.state` must be plain JSON: a flow whose state holds
  a class instance, a function or a `Date` is not forwarded and goes to
  `fallback`. After a graceful `bot.stop()` the checkpoint is kept, so the
  replica that takes over (or this one, restarted within the TTL) continues.
- **`fallback`** applies to what cannot be serialized (an async function's
  stack and closures). The conversation keeps a small stub in the store while
  it waits (two writes per conversation: one when it first waits, one to
  clear it). The replica that takes the chat then:
  - `'notify'`: replies `notifyMessage` (default: the localized
    `core.conversation.interrupted` text) and consumes the message;
  - `'restart'`: enters the conversation again by name, from the beginning,
    with its initial state (what ran before its first wait runs again);
  - a function `(info, ctx) => boolean`: your migration; return `true` when
    it consumed the message;
  - `'drop'` (default): nothing, the message routes normally.

**A step cut short keeps its answer.** When a step's first question was
already answered but the step had not finished (a slow validator, a `.do()`
after its `c.ask`) and the step is suspended (`settleMs`, a lost turn), the
answer is recorded in the checkpoint before the step goes on. The replica
that takes the chat feeds it that answer instead of asking again, and keeps
the waking message for the next question. With `durability` the checkpoint
only points at the journaled message (and the step's sends are deduplicated
by the outbox); without it, the message itself is embedded when it fits
`maxAnswerBytes` (default 16 KiB). What the `before('message')` hooks made of
the answer (a voice transcript in `ctx.body`, `ctx.type`, `ctx.lang`) travels
with it; the hooks do not run again.

**Acknowledgements follow the checkpoint.** With `durability`, an inbound
record is acknowledged only after the checkpoint write that holds its effect
landed (the parked marker, the recorded answer). If that write failed, a
suspended step releases the record instead, so it is replayed and taken as
the answer. Checkpoint writes are fenced like sends: a replica that lost the
chat's turn never overwrites or clears the checkpoint of the replica that
took it.

Limits:

- The unit of hand-over is the step. A step run again on the new replica runs
  its side effects before its first wait again: sends are deduplicated only
  with `durability`, and `.do()` work is at-least-once.
- Answers to later questions of a multi-question step (a text-mode form, a
  `.do()` with several `c.ask`) are not forwarded: the step restarts.
- Without `durability`, the prompt send and its marker are not atomic: a
  crash in between asks once more. Answers larger than `maxAnswerBytes` are
  not embedded (the step asks again).
- A wait's timeout restarts on the new replica, bounded by the TTL. `c.idle()`
  watchdogs are armed again only by the code that runs again.
- A conversation suspended before its first wait leaves no stub (nothing to
  hand over yet).
- Async conversations are never migrated automatically.
- The fence is a local check right before each write (like sends), not a
  conditional write in the store.

## Requirements and limits

- **A shared store** (`RedisStore`, or Postgres/Mongo/MySQL). With
  `MemoryStore`/`SQLiteStore` each replica has its own data.
- **Multi-turn flows should be `.persistent()`** (or use
  [`handover`](#conversation-hand-over)). Without it, a plain
  `bot.conversation` or non-persistent flow lives in the memory of the
  replica that started it; if the next message reaches another replica it is
  routed as a fresh message. With coordination a persistent flow is
  checkpointed as soon as it is entered, so even its first question survives
  a hand-over.
- **Inbound dedupe is per process.** A webhook retry that reaches another
  replica is processed again. Make handlers idempotent, keep the transport
  on one replica (`'leader'`), or turn on [`durability`](./durability.md) with
  a shared backend: its inbox journal deduplicates across the replicas.
- **A message waiting for its turn on a replica that dies is lost** (as in a
  single process that crashes), unless `durability` is on with a shared
  backend: the message was journaled on arrival and another replica replays
  it once its lease expires.
- **Scheduled jobs (`bot.schedule/every`) run on every replica.** Use a
  leader-only job with `coordinator.tryLead(name)` or the fenced lock below.
- **A conversation step longer than `settleMs` is cut short** (see above):
  raise `settleMs` for long `.do()` work or delays.
- **Redis**: one primary (standalone or Sentinel). A failover that loses the
  last writes can grant a lease twice. Redis Cluster is not supported.

## Choosing `leaseMs`

`leaseMs` (default `15s`) is the takeover time after a crash, and also how
long a replica may freeze before it gives up its chats. Keep it well above
your worst event-loop pause and Redis round trip; 5 to 30 seconds suits most
bots. Locally, turn waits poll Redis every 5 to 100 ms (`maxPollMs`).

## Events

```ts
bot.on('coordination:leader', ({ name, fence }) => log.info({ name, fence }, 'connected the transport'))
bot.on('coordination:follower', ({ name, reason }) => log.warn({ name, reason }, 'standing by'))
bot.on('coordination:lease-lost', ({ key, reason }) => log.warn({ key, reason }, 'lease lost'))
bot.on('coordination:handover', ({ key, name, outcome }) => log.info({ key, name, outcome }, 'conversation handed over'))
bot.on('error', ({ error }) => {
  // CoordinationUnavailableError: a message could not get its turn (timeout or Redis down)
})
```

## Singleton jobs and fenced locks

Durable scheduler tasks (`bot.every('5m', { id: 'report' }, fn)` with
`BotConfig.scheduler`, see the [scheduler guide](./scheduler.md))
already run each occurrence on one replica at a time. With `coordination` set,
the scheduler's leadership (`scheduler.lease`) defaults to the same coordinator,
so one Redis backend coordinates chats, the transport session and the
scheduler. Pass `scheduler.lease` explicitly (for example `store.leases()`) to
use a different backend.

For a plain (non-durable) task, take the leadership yourself:

```ts
const coordinator = store.coordinator()
bot.every('5m', async () => {
  const lead = await coordinator.tryLead('job:report')   // null on the other replicas
  if (!lead) return
  try { await sendReport() } finally { await lead.release() }
})
```

For your own critical sections, `store.acquireLockFenced(key, ttlMs)` returns
`{ token, fence }`: the fence grows on every acquisition, so a resource can
reject a write from a holder that stalled past its lock. Extend a long section
with `renewLock(key, token, ttlMs)` and release with `releaseLock(key, token)`.
The older `acquireLock` still works but has no fence (deprecated).

## Docker Compose with two replicas

```yaml
services:
  redis:
    image: redis:7-alpine
  bot:
    build: .
    environment:
      REDIS_URL: redis://redis:6379
    volumes:
      - ./sessions:/app/sessions   # Baileys: the leader needs the session files
    deploy:
      replicas: 2
    depends_on: [redis]
```

With Baileys, every replica must reach the same session files (a shared
volume): only the leader opens them, but any replica can become the leader.

## Testing

`MemoryCoordinator` is the in-process reference implementation. Bots that
share one `MemoryCoordinationHub` coordinate like replicas sharing Redis, and
`coordinator.crash()` simulates a replica dying:

```ts
import { Bot, MemoryCoordinationHub, MemoryCoordinator, MemoryStore } from '@bot-wa/core'

const hub = new MemoryCoordinationHub()
const store = new MemoryStore()
const a = new Bot({ provider: pa, store, coordination: { coordinator: new MemoryCoordinator({ hub, replicaId: 'a' }) } })
const b = new Bot({ provider: pb, store, coordination: { coordinator: new MemoryCoordinator({ hub, replicaId: 'b' }) } })
```
