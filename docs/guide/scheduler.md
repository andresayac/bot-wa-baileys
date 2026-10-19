# Scheduler

Run tasks on a schedule: every interval, with cron, or after a delay. Each
method returns a `ScheduledTask` you can cancel.

## every — repeat at interval

```ts
bot.every('30 seconds', () => console.log('💓 heartbeat'))
bot.every('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '⏰ reminder')
})
bot.every('2 hours', async () => { /* cleanup */ })
bot.every(60000, () => console.log('1 minute'))  // ms
```

### Accepted formats

| String | Equivalent |
|---|---|
| `'30 seconds'` | 30000 ms |
| `'5 minutes'` | 300000 ms |
| `'2 hours'` | 7200000 ms |
| `'1 day'` | 86400000 ms |

## schedule — cron expression

```ts
// Every day at 9:00 AM
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 Good morning!')
})

// Weekdays at 9:00 AM
bot.schedule('0 9 * * 1-5', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '💼 Time to work')
})

// Every 15 minutes
bot.schedule('*/15 * * * *', async () => { /* ... */ })
```

### Cron format (5 fields)

```
┌───── minute (0-59)
│ ┌───── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌───── month (1-12)
│ │ │ │ ┌───── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Each field takes `*`, a number, a range (`1-5`), a step (`*/15`, `1-30/5`) or a
comma-separated list of those. A `*` step counts from the field's minimum
(`*/3` in the month field is January, April, July and October; `*/2` in the
day-of-month field is the odd days).

Day rule of standard cron: when **both** day of month and day of week are
restricted, a day matches if **either** does — `0 9 13 * 5` runs every 13th
**and** every Friday. When one of them starts with `*` (including a step such as
`*/2`), both must match, so `0 9 * * 1` is just "Mondays". Names (`mon`, `jan`)
and macros (`@daily`) are not supported: `bot.schedule()` throws a `TypeError`
naming the offending field instead of creating a task that never runs.

## delay — once after X time

```ts
bot.delay('10 seconds', () => console.log('⏰ 10s elapsed'))
bot.delay('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', 'All good?')
})
```

## Cancelling a task

`bot.schedule`, `bot.every` and `bot.delay` all return a `ScheduledTask`
with a `.cancel()` method:

```ts
const heartbeat = bot.every('30 seconds', () => console.log('💓'))

// later
heartbeat.cancel()
```

## Durable tasks (survive restarts, one replica per run)

The tasks above live in memory: a restart forgets when they were due, and with
several replicas each one runs its own copy. Give a task a stable `id` and it
becomes **durable**:

- its next run time is stored, so a restart keeps the schedule instead of
  planning again from "now";
- the occurrences missed while the bot was down follow a policy (`missed`);
- each occurrence is claimed under a fenced lease in the shared store, so N
  replicas never run it at the same time (it is still at least once: see
  [Guarantees and limits](#guarantees-and-limits)).

It is opt-in: tasks without `id` and bots without `scheduler` behave exactly as
before.

```ts
import { Bot } from '@bot-wa/core'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const store = new SQLiteStore({ file: './data/bot.db' })
const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })

// Same methods, with options before the handler.
bot.schedule('0 9 * * 1-5', { id: 'morning-digest', missed: 'run-once' }, async (run) => {
  await sendDigest({ idempotencyKey: run.occurrenceKey })
})
bot.every('15m', { id: 'sync-crm', missed: 'catch-up', maxCatchUp: 4 }, async (run) => { /* ... */ })
```

Register durable tasks **at boot, on every replica**: only the schedule is
stored, never the handler, so after a restart a task runs only if the code
registers its id again (see [Registering tasks](#registering-tasks)).

The handler receives a `ScheduledRun`:

| Field | Meaning |
|---|---|
| `taskId` | The task's `id`. |
| `scheduledAt` | The slot this run covers (not the wall clock it started at). |
| `occurrenceKey` | `` `${taskId}@${scheduledAt.toISOString()}` ``: stable per occurrence, use it as an idempotency key. |
| `fencingToken` | Token of the claim: strictly increasing per task id, also across `cancel()` and a new registration. Pass it downstream to reject stale writes. The runs of one catch-up share their claim, and so their token. |
| `missed` | `true` when the run comes from the missed-run policy. |
| `signal` | Aborted when the bot stops or the lease on this occurrence is lost. |

### Options

| Option | Default | Meaning |
|---|---|---|
| `id` | (required) | Stable, unique per bot. The bot's store namespace is applied, so bots sharing a backend never collide. Registering the same id twice throws a `TypeError`. |
| `missed` | `'skip'` | What to do with the occurrences missed while no scheduler ran (see below). |
| `maxCatchUp` | `10` | Most missed slots `'catch-up'` runs. |
| `leaseMs` | `'60s'` | How long a claimed occurrence stays leased; renewed every third of it while the handler runs. |

### Missed runs

A slot is **missed** when it is claimed more than a grace period after it fell
due, which happens when no replica was running it (the bot was down, or every
replica was stopped). The grace period is `tickMs` (1 s by default), plus twice
`leaderTtlMs` when a leader `lease` is set (a follower or a failover can take
that long to step in, and that is not a missed run). Every replica decides it
from the stored state alone, so they all agree. Missed slots follow the task's
policy:

- `'skip'`: run none of them and wait for the next slot after now.
- `'run-once'`: run one occurrence (`missed: true`, `scheduledAt` is the first
  missed slot), then wait for the next slot.
- `'catch-up'`: run every missed slot in order, each with its own
  `scheduledAt` and `occurrenceKey`, up to `maxCatchUp`; the rest are skipped
  and logged. The whole catch-up runs under one claim on one replica and is
  committed at the end: if that process dies halfway, the catch-up starts over
  from its first slot (deduplicate with `run.occurrenceKey`); if it is stopped,
  it resumes from the first slot it did not run.

An occurrence interrupted by a crash (its runner died holding the lease) is not
missed: once the lease expires it runs again as itself (`missed: false`), and
the policy applies to the slots after it.

A one-shot `delay` counts as one slot: `'skip'` drops a reminder that fell due
while the bot was down, so use `'run-once'` for reminders. Its run time is
fixed when the id is first stored; a restart does not push it back. After it
runs, the row stays as a tombstone (registering the id again does not run it
again) until `cancel()` or `bot.forgetTask(id)` deletes it.

Interval slots do not drift: the next slot is the previous slot plus the
interval, not "now" plus the interval. Cron stays in local time.

### Registering tasks

- Register recurring tasks at boot, on every replica, with the same id and
  spec. A task can also be registered while the bot runs (the first durable
  task starts the durable engine), but it is only durable for as long as some
  code registers it again after each restart.
- Per-entity reminders (one id per order, per user...) are fine as long as you
  can rebuild them at boot from your own data: registering the same id again
  keeps its original run time.

```ts
// At boot: re-register the follow-ups still pending in your database.
for (const order of await orders.pendingFollowUps()) scheduleFollowUp(order.id)

// And when an order is created (from a handler):
function scheduleFollowUp(orderId: string) {
  bot.delay('2h', { id: `follow-up:${orderId}`, missed: 'run-once' }, async (run) => {
    await sendFollowUp(orderId, { idempotencyKey: run.occurrenceKey })
    await bot.forgetTask(run.taskId) // done: drop the tombstone
  })
}
```

A per-entity id that no code registers after a restart is an orphan: it is
kept and never run.

### Backends

`BotConfig.scheduler` takes:

| Option | Default | Meaning |
|---|---|---|
| `store` | in memory | Where schedules persist. `SQLiteStore#schedules()` (table `schedules`, same connection) or `RedisStore#schedules()` (`{prefix}:sched:{id}`, same client). Without it durable tasks work but do not survive a restart, and a warning is logged once. |
| `lease` | none | Optional leadership, which saves store round-trips with many replicas: the replica holding `scheduler:leader` claims on time, and the others only claim an occurrence left overdue for `leaderTtlMs` (a task only they registered, e.g. during a rolling deploy, or a dead leader), so such a task runs up to `leaderTtlMs` late. Either a fenced `LeaseProvider` (`RedisStore#leases()`, `MemoryLeaseProvider`) or a multi-replica `Coordinator` (`store.coordinator()`); with `BotConfig.coordination` it defaults to that coordinator. Correctness never depends on it. |
| `owner` | random | This process's lease-owner id. |
| `tickMs` | `'1s'` | Poll period: picks up an occurrence whose runner crashed (once its lease expires) and retries after store errors. |
| `leaderTtlMs` | `'30s'` | TTL of the leader lease. With a `Coordinator` (which renews its leadership itself) it is only the follower's grace; default: the coordinator's `leaseMs`. |

Any object implementing `ScheduleStore` works (exported from
`@bot-wa/core`, with `MemoryScheduleStore` as the reference). Postgres, MySQL
and Mongo backends are not written yet.

### Guarantees and limits

- **At least once per occurrence**, never two runs of a task at the same time
  (while leases hold). If a runner crashes, or stalls longer than `leaseMs`,
  its lease expires and another replica (or the restarted process) runs the
  same slot again. The stale runner's `signal` aborts and its commit is
  rejected (logged). Make handlers idempotent with `run.occurrenceKey`.
- **Only the schedule is stored**, not the handler. A stored id that no
  registered task claims is an **orphan**: it is logged once at start, kept, and
  never run. Remove it with `bot.forgetTask(id)` (a standalone `Scheduler` has
  `forget(id)`), which applies the bot's namespace for you. That namespace
  includes the `botId`, the provider and the connection id: changing any of
  them leaves the old rows as orphans.
- Deleted ids keep a small marker with their last fencing token (so tokens never
  go backwards), and one-shot tasks keep their tombstone: with many per-entity
  ids, forget them once done.
- Changing a task's spec (cron or interval) between deploys plans it again from
  now; the missed policy does not apply to the old spec.
- `stop()` pauses: rows are kept. `task.cancel()` deletes the row.
- Lease deadlines use each replica's clock: keep clocks in sync (NTP) and
  `leaseMs` far above the expected skew.
- `bot.onIdle()` stays in memory on purpose: per-chat idle timers are rebuilt
  by inbound traffic.

## Next steps

- [Sub-APIs](./sub-apis) — groups, profile, chats, etc.
- [Deployment](./deploy) — production setup
