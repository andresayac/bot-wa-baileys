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
- each occurrence is claimed under a fenced lease in the shared store, so with
  N replicas it runs on exactly one of them.

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
bot.delay('2h', { id: `follow-up:${orderId}` }, async () => { /* ... */ })
```

The handler receives a `ScheduledRun`:

| Field | Meaning |
|---|---|
| `taskId` | The task's `id`. |
| `scheduledAt` | The slot this run covers (not the wall clock it started at). |
| `occurrenceKey` | `` `${taskId}@${scheduledAt.toISOString()}` ``: stable per occurrence, use it as an idempotency key. |
| `fencingToken` | Strictly increasing per task; pass it downstream to reject stale writes. |
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

Applied once, when the scheduler starts and finds a slot overdue by more than
`tickMs` (1 s by default):

- `'skip'`: run none of them and wait for the next slot after now.
- `'run-once'`: run one occurrence (`missed: true`, `scheduledAt` is the first
  missed slot), then wait for the next slot.
- `'catch-up'`: run every missed slot in order, each with its own
  `scheduledAt` and `occurrenceKey`, up to `maxCatchUp`; the rest are skipped
  and logged.

A one-shot `delay` counts as one slot: `'skip'` drops a reminder that fell due
while the bot was down, so use `'run-once'` for reminders. Its run time is
fixed when the id is first stored; a restart does not push it back. After it
runs, the row stays as a tombstone (it does not fire again on the next boot)
until `cancel()` deletes it.

Interval slots do not drift: the next slot is the previous slot plus the
interval, not "now" plus the interval. Cron stays in local time.

### Backends

`BotConfig.scheduler` takes:

| Option | Default | Meaning |
|---|---|---|
| `store` | in memory | Where schedules persist. `SQLiteStore#schedules()` (table `schedules`, same connection) or `RedisStore#schedules()` (`{prefix}:sched:{id}`, same client). Without it durable tasks work but do not survive a restart, and a warning is logged once. |
| `lease` | none | Optional leadership: only the replica holding `scheduler:leader` claims, which saves store round-trips with many replicas. `RedisStore#leases()` gives a fenced one. Correctness never depends on it. |
| `owner` | random | This process's lease-owner id. |
| `tickMs` | `'1s'` | Poll period: picks up an occurrence whose runner crashed (once its lease expires) and retries after store errors. |
| `leaderTtlMs` | `'30s'` | TTL of the leader lease. |

Any object implementing `ScheduleStore` works (exported from
`@bot-wa/core`, with `MemoryScheduleStore` as the reference). Postgres, MySQL
and Mongo backends are not written yet.

### Guarantees and limits

- **At least once per occurrence.** If a runner crashes, or stalls longer than
  `leaseMs`, its lease expires and another replica (or the restart) runs the
  same slot again. The stale runner's `signal` aborts and its commit is
  rejected (logged). Make handlers idempotent with `run.occurrenceKey`.
- **Only the schedule is stored**, not the handler. A stored id that no
  registered task claims is an **orphan**: it is logged once at start, kept, and
  never run. Remove it with `store.schedules().delete(id)` (a standalone
  `Scheduler` also has `forget(id)`).
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
