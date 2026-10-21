---
"@bot-wa/core": minor
---

Cron time zones in the scheduler (opt-in). `bot.schedule(cron, { timeZone: 'America/Bogota' }, fn)` (new `CronTaskOptions` type), `DurableTaskOptions.timeZone` for durable tasks and `SchedulerOptions.timeZone` (`BotConfig.scheduler.timeZone`) as the default zone of every cron task; `'local'` is the process zone. Built on `Intl` only. Daylight-saving policy: a fixed-hour slot in a skipped hour runs once, shifted forward by the gap; in a repeated hour it runs once, at the first occurrence; wildcard-hour slots follow the real clock. Durable tasks store the zone in their spec (`TZ=<zone> <cron>`), so tasks without a zone keep their stored spec unchanged. `cronNextRun(expr, from, timeZone?)` takes the zone, and `ScheduledTask.timeZone` reports it. An unknown zone throws a `RangeError` at registration; `every`/`delay` reject `timeZone`. Without `timeZone`, nothing changes.
