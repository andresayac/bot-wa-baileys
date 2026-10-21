# Operations: metrics, events, inbox and delivery

This page covers two things: the runtime metrics every `Bot` exposes (part of
`@botmesh/core`) and the optional operational packages (event journal, inbox,
CRM, campaigns...). To send one message to many chats or start a flow from a
job, see [Broadcasts](./messages#broadcasts) and
[Starting a flow programmatically](./messages#starting-a-flow-programmatically).
To survive crashes without losing or duplicating messages (durable inbox/outbox,
retries, dead-letter queue), see [Durable message processing](./durability).

## Runtime metrics

`bot.metrics()` returns an in-process snapshot of counters only the engine
knows. It is plain JSON and nothing is persisted: counters are monotonic
since the bot was constructed, or since `bot.resetMetrics()` (which zeroes
them and keeps the uptime).

```ts
const m = bot.metrics()
// {
//   startedAt, uptimeMs, uptime,   // uptime: '3d 4h', '5m 12s'...
//   conversations: { started, completed, ended, guarded, cancelled, timedOut, retriesExceeded, errored, avgDurationMs, active },
//   flows: { registro: { started, completed, ended, guarded, cancelled, timedOut, retriesExceeded, errored, avgDurationMs } },
//   messages: { in, out, outFailed },
//   dropped: { duplicate, blocked, handoff },
//   triggered,   // bot.trigger() calls that started a conversation
//   errors,      // errors reported on bot.on('error')
// }
```

- `messages.in` counts inbound messages and interactions accepted after
  the access lists and dedupe. `out` / `outFailed` count the sends the
  provider accepted or rejected.
- `dropped.duplicate` counts redeliveries dropped by
  [inbound dedupe](./concepts#inbound-dedupe), `blocked` the messages,
  interactions and calls dropped by the blacklist / whitelist (every
  delivery, since blocked input is never recorded by dedupe), and `handoff` the messages not routed because the chat is
  [handed off to a human](./handoff).
- `flows` is keyed by conversation/flow name. `avgDurationMs` is the mean
  duration of the conversations that already ended (`0` when none did).
- A flow that returns and a `goto` count as `completed`; `c.end()` counts as
  `ended`; a failed `.guard()` (farewell or `redirect`) counts as `guarded`;
  `/cancel`, `/reset`, a replacement or `bot.stop()` count as `cancelled`.

### Prometheus

`toPrometheus(snapshot, { prefix?, labels? })` renders a snapshot in the
Prometheus text format (0.0.4), with no dependencies. Serve it with
`PROMETHEUS_CONTENT_TYPE`:

```ts
import { createServer } from 'node:http'
import { toPrometheus, PROMETHEUS_CONTENT_TYPE } from '@botmesh/core'

createServer((_req, res) => {
  res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE)
  res.end(toPrometheus(bot.metrics(), { labels: { bot: 'sales' } }))
}).listen(9464)
```

The default prefix is `botwa_`. Families: `uptime_seconds`,
`conversations_active`, `conversations_started_total`,
`conversations_ended_total{outcome}` (`completed` / `ended` / `guarded` /
`cancelled` / `timed_out` / `retries_exceeded` / `error`),
`conversation_duration_avg_seconds`,
`flow_started_total{flow}`, `flow_ended_total{flow,outcome}`,
`flow_duration_avg_seconds{flow}`, `messages_in_total`,
`messages_out_total{result}` (`sent` / `failed`),
`inbound_dropped_total{reason}` (`duplicate` / `blocked` / `handoff`),
`triggers_total` and `errors_total`. An invalid prefix or label name throws
`TypeError`.

### Conversation events

```ts
bot.on('conversation:started', ({ id, name, chatId, userId, key }) => { /* ... */ })
bot.on('conversation:ended', ({ id, name, chatId, outcome, completed, durationMs, goto }) => { /* ... */ })
```

- `conversation:started` fires whenever a flow or `bot.conversation` is
  entered: a trigger match, `bot.trigger()`, a dormant resume or a `c.goto()`.
- `conversation:ended` adds `outcome` (`'completed' | 'ended' | 'guarded' |
  'cancelled' | 'timedOut' | 'retriesExceeded' | 'error'`), `completed` (shorthand for
  `outcome === 'completed'`), `durationMs` and, when it ended with a `goto`,
  the target in `goto` (a new `started` follows).
- `id` is unique per conversation instance, so it pairs an `ended` with its
  `started`. `key` is the runtime key (`chatId`, or `chatId:userId` for a
  group participant). When a conversation is replaced, its `ended`
  (`outcome: 'cancelled'`) is emitted before the new one's `started`.
- A listener that throws is reported on `bot.on('error')`; it never breaks
  the conversation.

## Operational packages

::: warning Experimental packages — none is published
`@botmesh/events` is **experimental**: a real, tested implementation that is
still private (not on npm). The product packages (`@botmesh/inbox`,
`@botmesh/crm`, `@botmesh/hub`, `@botmesh/campaigns` and `@botmesh/deployments`)
are real and **persistent**: each has a storage contract, an in-RAM reference
store and a `Kv*` adapter over any `DurableKv` of the core (SQLite, PostgreSQL,
Redis, Redis Cluster or a file), with a shared conformance suite and opt-in
real-server suites. Their APIs may still change while the alpha is unpublished.
:::

The operational packages are transport-neutral and scoped by tenant.

### Event processing

Use `MemoryEventJournal` in tests. `FileEventJournal.open('./data/events.json')` persists a single-process journal with atomic snapshots, idempotency, leases, retries and replay. For multiple replicas, implement `EventJournal` over PostgreSQL, Redis or a broker.

`EventWorker` claims events, invokes the handler, acknowledges successful work and moves exhausted retries to the dead-letter state.

Every claim hands out a **fencing token** (`record.fencingToken`, strictly increasing per event and never reused, not even after `replay`). The worker passes it back to `ack`/`fail`, and the journal rejects a superseded token with `StaleLeaseError`: a worker whose lease expired while its handler was still running cannot complete, retry or dead-letter an event another worker has re-claimed. `runBatch()` reports those as `stale` (`{ processed, failed, stale }`), and it skips a record whose lease already ran out before its handler started, handing it back with `journal.release(eventId, { now, fencingToken })` so the skip does not use up an attempt. Handlers still run at least once, so keep them idempotent (the envelope's `idempotencyKey` is there for that). `new EventWorker(journal, { leaseMs, clock })` sets the lease length and the time source. An `EventJournal` adapter for PostgreSQL or Redis must check the token (in `ack`, `fail` and `release`) in the same atomic update that changes the state.

The same journal can also be a bot's durability backend (`eventsDurability({ journal })` from `@botmesh/events/durability`, see [Durable message processing](./durability.md#an-botmesh-events-journal)). The bot's inbound records are written on their own **channel** (`'botwa:durable'`). `list()` and `replay()` show them, but an `EventWorker` never claims them: a claim without a `channel` only takes records that have none. The bot processes them itself.

### Inbox and CRM

`@botmesh/inbox` provides optimistic-concurrency assignment (a compare-and-set on `version`), handoff, notes and unread state. Project ledger `StoredMessage` entries with `inbox.projectMessage(message)` so conversations can be rebuilt across channels; `attachInbox(bot, inbox)` does it for a running bot. Persist with `new Inbox(new KvInboxStore(kv))`.

`@botmesh/crm` stores contact channels, tags, attributes and marketing consent, with rule-based segments (`tagsAll`, `attributes` compared strictly, consent). `ContactDirectory` is async over `MemoryContactStore` or `KvContactStore`; `setConsent` retries concurrent writers instead of overwriting them. Always segment campaigns using tenant-scoped data and consent.

### Campaigns, plugins and deployments

`@botmesh/campaigns` skips opt-outs, mismatched segments and duplicate recipients. The store reserves one send slot per `(tenant, campaign, recipient)` with a TTL; `markSent` counts the send and `markFailed` releases the slot. `sendCampaign(bot, planner, …)` sends with `bot.broadcast()` and settles each delivery from the real result (accepted, failed, skipped by a hook or cancelled).

`@botmesh/hub` validates plugin manifests, runtime compatibility and granted permissions before enabling a plugin. Installs and enable/disable are persisted per tenant; it does not execute or sandbox untrusted code by itself.

`@botmesh/deployments` tracks immutable versions and one active deployment per tenant/bot, with reservations for running gates and an audit log of gate runs. Connect it to your deployment system for gradual rollout and physical rollback.

All five share the same storage model: `Memory…Store` (reference), `Kv…Store` over any `DurableKv`, a conformance suite in `test-utils/`, and tenant isolation enforced by the backend table name (`@botmesh/tenant-kv`).

## Tracing (OpenTelemetry)

`bot.metrics()` counts; traces explain. With `BotConfig.telemetry` the bot emits a span tree per message (inbound → dispatch → handler / conversation turn → AI model and tool calls → send), with ids hashed by default and no message content. `@botmesh/otel` sends those spans to OpenTelemetry (Jaeger, Grafana Tempo, any OTLP backend) and publishes `bot.metrics()` as OpenTelemetry metrics (`bot.plug(otelMetricsPlugin())`). Setup, span catalogue, personal-data policy and a Jaeger / Grafana Tempo example: [Tracing](./tracing).
