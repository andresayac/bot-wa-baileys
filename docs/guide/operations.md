# Operations: metrics, events, inbox and delivery

This page covers two things: the runtime metrics every `Bot` exposes (part of
`@bot-wa/core`) and the optional operational packages (event journal, inbox,
CRM, campaigns...). To send one message to many chats or start a flow from a
job, see [Broadcasts](./messages#broadcasts) and
[Starting a flow programmatically](./messages#starting-a-flow-programmatically).

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
  dedupe and the access lists. `out` / `outFailed` count the sends the
  provider accepted or rejected.
- `dropped.duplicate` counts redeliveries dropped by
  [inbound dedupe](./concepts#inbound-dedupe), `blocked` the blacklist /
  whitelist, and `handoff` the messages not routed because the chat is
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
import { toPrometheus, PROMETHEUS_CONTENT_TYPE } from '@bot-wa/core'

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

::: warning Experimental and prototype packages — none is published
`@bot-wa/events` is **experimental**: a real, tested implementation that is
still private (not on npm). `@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/hub`,
`@bot-wa/campaigns` and `@bot-wa/deployments` are **prototypes**: minimal
in-memory sketches to explore the design. They don't persist anything, don't
scale beyond one process and are not meant for production.
:::

The operational packages are transport-neutral and scoped by tenant.

### Event processing

Use `MemoryEventJournal` in tests. `FileEventJournal.open('./data/events.json')` persists a single-process journal with atomic snapshots, idempotency, leases, retries and replay. For multiple replicas, implement `EventJournal` over PostgreSQL, Redis or a broker.

`EventWorker` claims events, invokes the handler, acknowledges successful work and moves exhausted retries to the dead-letter state.

### Inbox and CRM

`@bot-wa/inbox` provides optimistic-concurrency assignment, handoff, notes and unread state. Project ledger `StoredMessage` entries with `inbox.projectMessage(message)` so conversations can be rebuilt across channels.

`@bot-wa/crm` stores contact channels, tags, attributes and marketing consent. Always segment campaigns using tenant-scoped data and consent.

### Campaigns, plugins and deployments

`@bot-wa/campaigns` skips opt-outs, mismatched segments and duplicate recipients. A durable worker must perform the actual send and record delivery results.

`@bot-wa/hub` validates plugin manifests, runtime compatibility and granted permissions before enabling a plugin. It does not execute or sandbox untrusted code by itself.

`@bot-wa/deployments` tracks immutable versions and one active deployment per tenant/bot. Connect it to your deployment system for gradual rollout and physical rollback.
