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

## Next steps

- [Sub-APIs](./sub-apis) — groups, profile, chats, etc.
- [Deployment](./deploy) — production setup
