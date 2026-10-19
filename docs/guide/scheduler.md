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

### Time zones

By default the fields are read in the process time zone (`TZ` of the host).
Pass an IANA zone to read them in another one, per task or for the whole bot:

```ts
// One task: 9:00 on weekdays, Bogota time, wherever the server runs.
bot.schedule('0 9 * * 1-5', { timeZone: 'America/Bogota' }, async () => { /* ... */ })

// Durable tasks take it next to their id.
bot.schedule('30 2 * * *', { id: 'nightly-report', timeZone: 'Europe/Madrid' }, async (run) => { /* ... */ })

// Default for every cron task of the bot (a task's own timeZone wins; 'local' = process zone).
const bot = new Bot({ provider, scheduler: { timeZone: 'America/Mexico_City' } })
```

Zones are validated with `Intl` when the task (or the bot) is created: an
unknown name throws a `RangeError`. `every` and `delay` reject `timeZone`
(it only applies to cron fields). `task.timeZone` tells which zone a task uses.
Nothing changes for a task without a zone.

Daylight-saving transitions follow one documented policy. The hour field is a
**wildcard** when it starts with `*` (`*`, `*/2`), as for the day fields:

| Situation | Fixed hour (`30 2 * * *`) | Wildcard hour (`*/15 * * * *`, `0 * * * *`) |
|---|---|---|
| **Gap**: the local time does not exist (spring forward) | Runs once, shifted forward by the length of the gap (02:30 becomes 03:30), like RFC 5545 and Temporal's `'compatible'`. If the shifted time lands on another slot of the task, it runs once. | The slots inside the gap are skipped; the schedule continues at the first wall time that exists. |
| **Overlap**: the local time happens twice (fall back) | Runs once, at the first occurrence. | Runs in both passes (they are different instants, with different `occurrenceKey`s). |
| Transition at midnight (e.g. `America/Santiago`) | `0 0 * * *` runs at 01:00 that day; day-of-month and weekday still match the calendar day. | Same as above. |

Run times are always strictly increasing, and every replica computes the same
ones, so durable tasks agree on their slots, missed runs and catch-up across a
transition. The search looks up to four years ahead with a zone (so
`0 0 29 2 *` works) and one year without one.

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
| `timeZone` | `scheduler.timeZone`, else the process zone | Cron tasks only: IANA zone of the fields (see [Time zones](#time-zones)). It is part of the stored spec (`TZ=<zone> <cron>`), so adding or changing it plans the task again. |

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
interval, not "now" plus the interval. Cron uses the process zone unless the
task or `scheduler.timeZone` sets one (see [Time zones](#time-zones)).

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
| `store` | in memory | Where schedules persist: the `schedules()` of your store (see the table below). Without it durable tasks work but do not survive a restart, and a warning is logged once. |
| `lease` | none | Optional leadership, which saves store round-trips with many replicas: the replica holding `scheduler:leader` claims on time, and the others only claim an occurrence left overdue for `leaderTtlMs` (a task only they registered, e.g. during a rolling deploy, or a dead leader), so such a task runs up to `leaderTtlMs` late. Either a fenced `LeaseProvider` (`RedisStore#leases()`, `MemoryLeaseProvider`) or a multi-replica `Coordinator` (`store.coordinator()`); with `BotConfig.coordination` it defaults to that coordinator. Correctness never depends on it. |
| `owner` | random | This process's lease-owner id. |
| `tickMs` | `'1s'` | Poll period: picks up an occurrence whose runner crashed (once its lease expires) and retries after store errors. |
| `leaderTtlMs` | `'30s'` | TTL of the leader lease. With a `Coordinator` (which renews its leadership itself) it is only the follower's grace; default: the coordinator's `leaseMs`. |
| `timeZone` | process zone | Default IANA zone of every cron task of the bot, plain or durable (see [Time zones](#time-zones)). On its own it does not start anything. |

Every store package ships its schedule store, which shares the store's
connection and prefix:

| Store | `store.schedules()` | Storage |
|---|---|---|
| `@bot-wa/sqlite-store` | `SQLiteScheduleStore` | Table `schedules` (plus `schedule_fences`); each call is a `BEGIN IMMEDIATE` transaction. |
| `@bot-wa/redis-store` | `RedisScheduleStore` | `{prefix}:sched:{id}`, compare-and-set scripts. |
| `@bot-wa/postgres-store` | `PostgresScheduleStore` | Table `{tablePrefix}schedules`; every call is one atomic statement (`UPDATE … RETURNING` claims). |
| `@bot-wa/mysql-store` | `MysqlScheduleStore` | Table `{tablePrefix}schedules` (VARBINARY ids, up to 1024 bytes); claims run `SELECT … FOR UPDATE` in a short transaction. |
| `@bot-wa/mongo-store` | `MongoScheduleStore` | Collection `{collectionPrefix}schedules`; single-document commands (`findOneAndUpdate`), so a standalone `mongod` works. |

```ts
import { PostgresStore } from '@bot-wa/postgres-store'

const store = new PostgresStore({ connectionString: process.env.DATABASE_URL })
const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
```

The bot starts its store before the scheduler, and the scheduler creates the
table (idempotent `CREATE TABLE IF NOT EXISTS`). If you use a store only for
schedules, `await store.start()` first. The SQL and Mongo stores delete
softly: a forgotten id keeps its row with `deleted` set so its fencing token
never goes backwards. Purge old tombstones by hand only when no runner can
still hold their token (for example `DELETE FROM schedules WHERE deleted AND
updated_at < <a day ago>`).

Any object implementing `ScheduleStore` works (exported from
`@bot-wa/core`, with `MemoryScheduleStore` as the reference and the shared
suite `test-utils/schedule-store-conformance.ts` to check it).

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
- Time zones come from the ICU data of each Node build. When replicas run
  different tzdata (or a government changes its DST rules), the stored
  `nextRunAt` wins: replicas follow the row, and only the next computation
  picks up the new rules. A zone unknown to a replica's Node fails its
  registration at boot, visibly.
- `bot.onIdle()` stays in memory on purpose: per-chat idle timers are rebuilt
  by inbound traffic.

## Next steps

- [Sub-APIs](./sub-apis) — groups, profile, chats, etc.
- [Deployment](./deploy) — production setup
