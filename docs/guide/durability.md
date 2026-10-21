# Durable message processing

By default a `Bot` keeps everything in flight in memory. If the process dies while
it is handling a message, that message is lost (unless the channel redelivers it),
and a reply that was being sent may or may not have gone out. That is fine for
many bots. When it is not, turn on **durability**:

```ts
import { Bot } from '@bot-wa/core'
import { PostgresDurability, PostgresStore } from '@bot-wa/postgres-store'

const bot = new Bot({
  provider,
  store: new PostgresStore({ pool }),
  durability: {
    journal: new PostgresDurability({ pool }),
    instanceId: 'bot-1',               // stable across restarts of this deployment
    outbox: { retries: 5, backoff: { baseMs: 1000, capMs: 60_000 } },
  },
})
```

With `durability` set, the bot keeps two journals:

- The **inbox**. Every admitted message or interaction is written down before any
  handler runs, and marked done only once its effects settled. After a crash, the
  next start replays what was left unfinished.
- The **outbox**. Every send is written down under an **idempotency key** before the
  provider is called, and the provider's message id is recorded right after. A send
  whose key is already recorded is answered from the outbox instead of going out
  again. That is how a replay avoids sending the same reply twice. Failed sends are
  retried with backoff and dead-lettered when they run out of retries.

Without the `durability` key nothing changes: the bot runs exactly the code it ran
before, in memory and in a single process.

## Backends

| Backend | Package | Survives a crash | Several replicas |
| --- | --- | --- | --- |
| `MemoryDurability` (the default with `durability: {}`) | `@bot-wa/core` | No (retries, backoff and DLQ only) | No |
| `FileDurability.open(path)` | `@bot-wa/core` | Yes | No (a lock file refuses a second live process, and a second open in the same process until `close()`) |
| `PostgresDurability({ pool \| connectionString, tablePrefix })` | `@bot-wa/postgres-store` | Yes | Yes, with sticky per-chat routing (see [Several replicas](#several-replicas)) |
| `RedisDurability({ client \| url, prefix })` | `@bot-wa/redis-store` | Yes (with Redis persistence on) | Yes, with sticky per-chat routing (see [Several replicas](#several-replicas)) |
| `eventsDurability({ journal })` | `@bot-wa/events/durability` (private, monorepo only) | With a `FileEventJournal` opened with `{ lock: true }` or a `SharedFileEventJournal` | With a `SharedFileEventJournal` (processes on one host; see [below](#an-bot-wa-events-journal)) |

PostgreSQL creates one table, `{tablePrefix}durable`, idempotently on start.
Redis uses keys under `{prefix}:{durable:inbox:<scope>}` and `{prefix}:{durable:outbox:<scope>}`.
Neither touches the store's own tables or keys.

`FileDurability.open(path, { appendLog: true })` (or `{ compactEvery, compactBytes, fsync }`)
appends each committed write to `<path>.log` instead of rewriting the snapshot, and compacts
every 1000 entries or 4 MiB; `close()` folds the log into the snapshot. A leftover log is
always replayed on open, even without the option.

**Several bots can share one backend.** Each bot works in its own view of the
backend, scoped by its namespace (`tenantId`, `environmentId`, `botId`,
`connectionId`; `bot.durability.scope` is the derived id). A bot claims, replays and
deduplicates only its own records, and explicit idempotency keys are per bot: two bots
enqueueing `reminder:1` each send their own. A custom backend that has no `scope()`
must not be shared between bots. Every backend passes the same
conformance suite (`test-utils/durability-conformance.ts`), and you can write your
own by implementing the small `DurableKv` interface (versioned compare-and-set plus
two sorted indexes) and wrapping it in `KvDurability`.

The bot starts and stops the backend itself. Use a persistent **store** too: a
`.persistent()` flow's checkpoints live in the store, and replay relies on them.

### An `@bot-wa/events` journal

An app that already keeps an `@bot-wa/events` journal can use it as the backend, with
no other store:

```ts
import { FileEventJournal } from '@bot-wa/events'
import { eventsDurability } from '@bot-wa/events/durability'

const journal = await FileEventJournal.open('./data/events.json', { lock: true })
const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
// after bot.stop(): await journal.close()
```

- The inbox records are `EventRecord`s of that journal, on the channel
  `'botwa:durable'`, with `eventType` `'botwa.inbound.message'` or
  `'botwa.inbound.interaction'`. The journal's `list()` and `replay()` see them, and a
  `replay` is picked up by the bot's sweeper. An `EventWorker` never claims them: a
  claim without a channel only takes records without one.
- The outbox is the core outbox kept as a *sidecar* of the journal: the same file and
  the same atomic snapshot as the inbox.
- A `FileEventJournal` must be opened with `{ lock: true }`. The pid lock file stops a
  second process from opening it, and a second `open()` of the same file in the same
  process is refused until the first journal is closed.
- Cost: a `FileEventJournal` rewrites its **whole** file on every write, and here that
  file holds the app's own events, the bot's inbound records (kept for the retention
  window, 7 days by default) and the outbox. Each inbound message and each send cause a
  few rewrites (concurrent writes share one, and lease heartbeats only write with the
  next change). For more than light traffic, give the bot a journal file of its own,
  keep the retention short, or pass a database-backed `outbox`; or use
  `FileDurability` or a database backend instead.
- For several replicas you need a shared `LeasedEventJournal` with atomic, fenced
  operations. `SharedFileEventJournal` is one: several processes open the same file, and
  every write runs under a cross-process mutex (`<file>.mutex`) against the current file,
  so claims are exclusive and fencing tokens hold across processes. The outbox lives in
  the same file and is shared too:

  ```ts
  import { SharedFileEventJournal } from '@bot-wa/events'

  const journal = await SharedFileEventJournal.open('./data/events.json')
  const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
  ```

  It is meant for a few processes on one host (or a filesystem with atomic rename and
  exclusive create; not NFS). By default every write rereads and rewrites the whole file;
  with `appendLog: true` (or `{ compactEvery, compactBytes, fsync }`) each write instead
  appends one line with the records/side state that changed to `<file>.log`, and the
  snapshot is rewritten (carrying `logSeq`) and the log truncated every 1000 entries or
  4 MiB. A crash between the snapshot and the truncation is harmless (replay skips entries
  already in the snapshot) and a torn last line is cut off. A mutex left by a dead process
  is broken at once; a live holder refreshes its mtime (heartbeat, `heartbeatMs` default a
  third of `staleLockMs`), so only a stalled holder is treated as abandoned after
  `staleLockMs` (default 30 s). Nothing is ever killed (keep `staleLockMs` well above the
  slowest write: if three processes race to break an already stalled mutex, two of them can
  briefly hold it and one write may be lost; use a database journal where that matters).
  `close()` lets the operations already called finish and rejects later ones. The file format is the
  `FileEventJournal` one, but never open a file with both at the same time (the shared
  journal refuses a file a live locked `FileEventJournal` holds, also when that journal
  opens it later: every shared operation then rejects instead of losing records). The same-chat rule of
  [Several replicas](#several-replicas) applies. For heavy traffic, use another
  `LeasedEventJournal` with a shared `outbox` (`eventsDurability({ journal, outbox: kv })`,
  with the `DurableKv` of a Postgres or Redis backend), or those backends directly.

## What is guaranteed

Sends are **exactly once while the process is alive**. Across a crash they are
exactly once, except in one window that no channel lets anyone close: the process
dies after the provider accepted a message but before the outbox recorded it.

| The process dies… | On restart |
| --- | --- |
| before the inbound is journaled | Nothing was recorded. The message is processed if the channel redelivers it (webhooks do; Baileys may not). |
| after it is journaled, before or while the handler runs | The message is replayed. Replies that already went out are answered from the outbox; the missing ones are sent. |
| between "about to call the provider" and "sent" being recorded | **Ambiguous.** `onAmbiguous: 'skip'` (default) marks the send `unknown`: never a duplicate, possibly lost. `'resend'` sends it again: never lost, possibly a duplicate. Either way `'durability:ambiguous'` fires. |
| after the send is recorded, before the inbound is acknowledged | The message is replayed; every reply is answered from the outbox. |
| while a persistent flow waits for an answer | The flow resumes from its checkpoint. The pending question is not repeated and the next message is taken as its answer. |
| while a **non-persistent** flow waits for an answer | The conversation is gone (it lived in memory). The replayed answer goes through the normal routing as a new message, and its reply is sent (see `onDiverged` below). Make flows that must survive a restart `.persistent()`. |
| on every run of the same message (it crashes the process) | The message is replayed until `inbox.maxAttempts` runs were charged without completing, then dead-lettered (`'durability:dead'`) instead of crashing the next start again. |

Handlers are **at least once**: a replayed message runs its handler again, and only
its sends are deduplicated. Keep other side effects idempotent (an upsert, a
`ctx.user.set`, a database write keyed by `ctx.ref.id`), or give them their own key.

## Idempotency keys

Every send gets a key:

1. `options.idempotencyKey` when you pass one: `bot.send(chatId, text, { idempotencyKey: 'invoice:42' })`.
2. Otherwise, while handling an inbound message: `<inbound record id>:<n>`, the
   n-th send made for that message. A conversation step uses the message that fed
   it, so the replies of a flow keep their keys when the flow resumes.
3. Otherwise a random key. The send still gets retries and survives a crash, but a
   second call is not recognised as the same send.

Because of rule 2, **a durable handler must send in a deterministic order**. If a
replay makes a different number of sends, or sends them in another order, the keys
no longer line up: extra sends go out, and sends that disappeared are not
recognised. For sends whose order depends on timing (`bot.broadcast` with
`concurrency > 1`, `Promise.all` of replies) pass explicit keys.

The outbox also stores a fingerprint of each send (chat + content, before the
`before('send')` hooks). When a replay produces **different content** under a key of
rule 2, the handler took another path (a non-persistent flow lost on the crash, a
condition that changed). `outbox.onDiverged` decides: `'send'` (default) sends the new
content under a new key, so no reply is silently swallowed; `'skip'` answers it from the
recorded send, as before. Either way `metrics().outboxDiverged` counts it and a warning
is logged. Choose `'skip'` when replies are not deterministic (AI-generated text) and a
second, different answer would be worse than none. Explicit keys are never compared:
the key you pass names the send.

The provider never sees `idempotencyKey`: core strips it before calling the provider.

## Retries, deferral and the dead-letter queue

A failed send is retried with backoff (a `RateLimitedError` waits at least its
`retryAfterMs`), unless the error is final. These errors are final and go straight
to the DLQ: `UnsupportedContentError`, `PayloadTooLargeError`,
`OutsideSessionWindowError`, `RecipientUnreachableError`, or any error with
`retryable: false`.

`ctx.reply` and `bot.send` keep retrying inline for up to `outbox.inlineMaxMs`
(default `15s`). After that they reject with `SendDeferredError`, carrying the
outbox `key`. The send is **not lost**: the background sweeper keeps retrying it.
When the caller does not need to wait, enqueue the send instead:

```ts
const { key } = await bot.enqueue(chatId, 'Tu cita es mañana a las 9', {
  idempotencyKey: `reminder:${cita.id}`,   // a second enqueue of this key is a no-op
})
```

`bot.enqueue` runs the `before('send')` hooks once, journals the send and returns
at once. The sweeper delivers it and then runs `after('send')` and writes the
message log. Within one process, sends to a chat keep their order while one of them
is being retried inline.

Inbound events whose processing keeps failing *before* the handlers run (the store
is down, for example) are retried with `inbox.backoff` and dead-lettered after
`inbox.maxAttempts`. A handler that throws is **not** retried: its side effects
already ran. The error goes to `bot.on('error')` and the event is acknowledged.

## Operating it

```ts
bot.on('durability:dead', ({ kind, id, error }) => alert(kind, id, error))
bot.on('durability:ambiguous', ({ key, chatId }) => audit(key, chatId))

const d = bot.durability!
await d.inbox.list({ state: 'dead' })          // the inbound DLQ
await d.outbox.list({ state: 'dead' })         // the outbound DLQ
await d.replayInbound(id)                      // process it again
await d.retrySend(key)                         // send it again (dead, failed or unknown)
await d.outbox.discard(key)                    // forget it
d.metrics()  // { inboundJournaled, inboundDuplicates, inboundReplayed, inboundDead,
             //   outboxJournaled, outboxDeduped, outboxRetried, outboxDeferred,
             //   outboxDead, outboxAmbiguous, outboxBypassed, staleLeases, outboxDiverged }
```

- **Leases and fencing.** A record being processed is leased to `instanceId` for
  `inbox.leaseMs` (default 60 s), and a send in flight for `outbox.leaseMs` (default
  60 s). A heartbeat extends both while the handler or the provider call runs, so a
  slow upload is never taken for an abandoned send. If a lease expires (the process
  died or froze), another replica, or this one after a restart, claims the record
  under a new fencing token. The old holder's completion is then rejected and
  counted in `staleLeases`.
- **`instanceId`.** Keep it stable across restarts of one deployment, so a restarted
  process reclaims its own unfinished records at once instead of waiting for their
  leases to expire. Make it unique per replica that runs at the same time (a pod name
  of a StatefulSet, for example): two live processes with one id would take each
  other's leases. On a single-process backend (memory, file) the default is
  `<hostname>/<botId>/<connectionId>`. On a shared backend (Postgres, Redis) the
  default adds a per-boot suffix, so two processes on one host never share it; a
  restart then waits for the old leases to expire. Set it explicitly to skip that wait.
- **Retention.** `done` and `sent` records are purged after `retention` (default
  `7d`). Keep it longer than the longest redelivery window of your channels, because
  a redelivery is only recognised while its record still exists.
- **Fail-closed.** If the journal cannot record an inbound event, the event is not
  dispatched. An `'error'` is emitted and the in-memory dedupe forgets the event, so
  a redelivery is processed. Set `failOpen: true` to dispatch without the journal
  instead.
- **Payload size.** Outbound content is journaled as JSON, with Buffers
  base64-encoded. A payload over `outbox.maxPayloadBytes` (default 1 MiB), or one
  that cannot be encoded (a stream), bypasses the outbox with a warning. Prefer URL
  or path media for large files.
- **Replayed media.** See [Media on replay](#media-on-replay).
- **Edits, drafts and typing indicators** are not journaled. Edits are idempotent,
  and drafts and indicators are transient.

## Media on replay

The journal does not store a message's media, only a reference to it. The bytes are
downloaded lazily with `loadMediaOf(ctx)`. On some channels that reference is a live
object: Baileys keeps the original WhatsApp message. So the inbox asks the provider for
a serializable, versioned reference (`IProvider.serializeMediaRef`) and journals that
instead. A message can be replayed after a crash, as a background retry, or by an
operator's `replayInbound`. In each case the provider rebuilds the reference
(`IProvider.rehydrateMediaRef`) before the handler runs, so the media downloads as it
would for a live message.

| Provider | What is journaled | Notes |
| --- | --- | --- |
| `@bot-wa/baileys` | The media content (CDN url, direct path, media key and hashes, without thumbnail, caption or quoted context) and the message key | Expired CDN media is re-requested from the sender's phone on download, as for live media. View-once media is **not** journaled unless you set `durableMedia: { viewOnce: true }`. |
| `@bot-wa/meta` (Cloud API) | The media id | Meta keeps inbound media for about 30 days. |
| `@bot-wa/telegram` | The `file_id` | It only works with the same bot token. |
| `@bot-wa/twilio` | The media URL | Only `https` URLs on the API origin or a `twilio.com` host are accepted back. |
| `@bot-wa/messenger`, `@bot-wa/instagram` | The attachment URL | Only URLs on the Meta CDNs (`fbcdn.net`, `fbsbx.com`, `cdninstagram.com`; `mediaRefHosts` replaces the list) are journaled and accepted back. The URLs are signed and expire, so a late replay fails to download. |
| `@bot-wa/discord` | The attachment URL | Only URLs on the Discord CDNs (`discordapp.com`, `discordapp.net`; `mediaRefHosts` replaces the list). Discord attachment URLs expire after about 24 hours. |
| Other providers | The token as it is (as before) | Their tokens are already plain ids or URLs. |

No credentials are journaled: tokens and keys are added again at download time. The
stored reference is validated when it is read back. A replayed message whose media
cannot be rebuilt **still runs**; only its download fails.
`loadMediaOf(ctx, { throwOnError: true })` then rejects with `MediaUnavailableError` (a
`ProviderError`), and its `reason` is one of these:

- `'not-durable'`: the provider did not serialize the reference (view-once, for example).
- `'provider-mismatch'`: another provider wrote the record.
- `'rehydrate-failed'`: the stored value is invalid, from an unknown version, or tampered with.

Without `throwOnError`, `loadMediaOf` resolves `undefined`, as it does for any failed
download.

```ts
bot.when(IMAGE, async (ctx) => {
  try {
    const media = await loadMediaOf(ctx, { throwOnError: true })
    // …
  } catch (error) {
    if (error instanceof MediaUnavailableError) return ctx.reply('Please send the image again.')
    throw error
  }
})
```

The reference grants access to the media, like the message body stored next to it, so
protect the journal as you protect the store. Set `durability.inbox.mediaRefs: false`
to journal media tokens as before; a replayed message may then be unable to download
its media. Records written before this feature replay as they did before.

A provider adds the two optional `IProvider` methods. `serializeMediaRef(ref)` is
synchronous and returns `{ v, data }` (JSON) or `undefined`. `rehydrateMediaRef(stored,
ref)` validates `stored`, throws a `ProviderError` when it is not valid, and does not
need the transport to be connected.

## Several replicas

The journals are safe to share: two replicas never both claim a record, and a stale
holder cannot complete one. The rest of the bot is still per process: active
conversations, their pending `ask`, and the per-chat queue live in the memory of the
replica that runs them. So:

- **Route each chat to one replica at a time** (sticky routing by chat id at the load
  balancer, or partition chats between replicas). If two replicas receive messages of
  the same chat, the answer to an `ask` that one replica is holding arrives at the other
  as a new message.
- **Failover is by lease.** When a replica dies or freezes, its unfinished records are
  claimed by another replica once their leases expire (`inbox.leaseMs`), and replayed
  there. A replica that is alive keeps its leases through the heartbeat, however long
  its handler takes.
- Give every replica its own explicit `instanceId`.

**With `coordination`** (see [Running N replicas](./replicas.md)), sticky routing is
not needed: chat turns serialize each chat across replicas and `.persistent()` flows
continue on whichever replica gets the next message. Bots of the same `botId` share one
journal scope, so any replica can replay or deliver a record. With a leader-only
transport session (`providerSession: 'leader'`, e.g. Baileys) a standby's outbox
sweeper never calls the transport (the attempt is refused with `ProviderNotLeaderError`
and retried); the leader delivers it.

With coordination, a record that fed a conversation step is acknowledged only once the
checkpoint write holding its effect landed (the parked marker, or the answer of a step
cut short); a suspended step whose write failed releases the record instead, so it is
replayed. A recorded answer points at its inbox record, so keep `retention` above your
longest conversation pause. See [Conversation hand-over](./replicas.md#conversation-hand-over).

## Testing crash recovery

`@bot-wa/core/testing` exports `crashable(backend)`, which can "kill" a bot at a
precise journal write, and `CrashableProvider`. Abandon the crashed bot and start a
new one on the same backend and store with the same `instanceId`:

```ts
import { crashable, CrashableProvider, MockProvider } from '@bot-wa/core/testing'

const shared = new MemoryDurability()
const a = crashable(shared)
a.crashBefore('outbox.markSent')    // the provider was called, the result is never recorded
const botA = new Bot({ provider: new CrashableProvider(a), store, durability: { journal: a, instanceId: 'i1' } })
// … drive botA until a.crashed …
const botB = new Bot({ provider: new MockProvider(), store, durability: { journal: shared, instanceId: 'i1' } })
```

The repository runs a crash matrix (`test-utils/durability-crash.ts`) against every
backend. It covers each crash point under both ambiguity policies, plus seeded
random points and a real child process killed in the middle of a handler.
