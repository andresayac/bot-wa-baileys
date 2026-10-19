/**
 * Scheduler — cron-style + interval + one-shot tasks.
 *
 * Plain tasks (`cron/every/delay(spec, fn)`) use tiny in-process timing and do not
 * survive restarts. Tasks registered with {@link DurableTaskOptions} (a stable `id`) are
 * durable: their schedule lives in a {@link ScheduleStore} (see {@link SchedulerOptions}),
 * survives restarts with a missed-run policy, and each occurrence runs on one replica.
 */

import type { Logger } from 'pino'
import type { CronTaskOptions, DurableTaskHandler, DurableTaskOptions, ScheduledTask } from '../core/types.js'
import { DurableScheduler, type DurableSchedulerOptions } from './durable.js'
import type { ScheduleKind, SchedulerOptions } from './ScheduleStore.js'
import { parseDuration, randomId } from '../utils/timers.js'
import { assertCron, cronNextRun } from './cron.js'
import { assertTimeZone } from './cronZone.js'

/** `opts` of `cron(expr, opts, fn)` selects a plain (in-memory) task with a time zone. */
function isPlainCronOptions(opts: object): opts is CronTaskOptions {
  const o = opts as Partial<DurableTaskOptions>
  return o.id === undefined && 'timeZone' in o && o.missed === undefined && o.maxCatchUp === undefined && o.leaseMs === undefined
}

/** `every`/`delay` reject a time zone (it only applies to cron fields). */
function rejectTimeZone(opts: unknown): void {
  if (opts !== null && typeof opts === 'object' && (opts as { timeZone?: unknown }).timeZone !== undefined) {
    throw new TypeError('timeZone only applies to cron tasks')
  }
}

interface InternalTask extends ScheduledTask {
  handler: () => void | Promise<void>
  timer?: NodeJS.Timeout
  /** Bumped by every schedule(): a run whose generation is stale must not reschedule. */
  generation: number
  nextRunDate: Date | null
  computeNextRun(): Date | null
}

export class Scheduler {
  private tasks = new Map<string, InternalTask>()
  private logger?: Logger
  private isRunning = false
  private readonly durable: DurableScheduler
  /** Default zone of cron tasks (`SchedulerOptions.timeZone`). */
  private readonly timeZone?: string

  /**
   * `opts` only affect durable tasks, except `timeZone` (the default zone of every cron
   * task); `new Scheduler()` keeps the in-memory behaviour.
   */
  constructor(opts: SchedulerOptions = {}) {
    if (opts.timeZone !== undefined) assertTimeZone(opts.timeZone, 'scheduler')
    this.timeZone = opts.timeZone
    this.durable = new DurableScheduler(opts as DurableSchedulerOptions)
  }

  /**
   * Start (or resume) every task. Plain tasks are armed synchronously. Returns a promise
   * only when durable tasks (or an explicit `store`) have to be restored: it rejects if
   * the schedule store fails, and must then be followed by {@link stop}.
   */
  start(logger?: Logger): Promise<void> | undefined {
    if (this.isRunning) return undefined
    this.logger = logger
    this.isRunning = true
    for (const task of this.tasks.values()) this.schedule(task)
    return this.durable.hasWork ? this.durable.start(logger) : undefined
  }

  /**
   * Pause every task (definitions and stored schedules are kept). Returns a promise only
   * when a leader lease (`SchedulerOptions.lease`) is being released; it never rejects.
   */
  stop(): Promise<void> | undefined {
    this.isRunning = false
    for (const t of this.tasks.values()) {
      if (t.timer) clearTimeout(t.timer)
      t.timer = undefined
    }
    return this.durable.stop()
  }

  /** Add a cron-style task. */
  cron(cronExpr: string, fn: () => void | Promise<void>): ScheduledTask
  /** Add a durable cron-style task (see {@link DurableTaskOptions}). */
  cron(cronExpr: string, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask
  /** Add a cron-style task read in a time zone (see {@link CronTaskOptions}). */
  cron(cronExpr: string, opts: CronTaskOptions, fn: () => void | Promise<void>): ScheduledTask
  cron(
    cronExpr: string,
    a: (() => void | Promise<void>) | DurableTaskOptions | CronTaskOptions,
    b?: DurableTaskHandler | (() => void | Promise<void>),
  ): ScheduledTask {
    if (typeof a !== 'function') {
      if (a !== null && typeof a === 'object' && isPlainCronOptions(a)) {
        if (typeof b !== 'function') throw new TypeError('A cron task needs a handler function as its last argument')
        if (a.timeZone !== undefined) assertTimeZone(a.timeZone, `cron task "${cronExpr}"`)
        return this.add(cronExpr, undefined, undefined, b as () => void | Promise<void>, a.timeZone)
      }
      return this.addDurable('cron', cronExpr, a as DurableTaskOptions, b as DurableTaskHandler)
    }
    return this.add(cronExpr, undefined, undefined, a)
  }

  /** Add an interval task ("5 minutes", "1 hour", or ms). */
  every(interval: string | number, fn: () => void | Promise<void>): ScheduledTask
  /** Add a durable interval task: slots are `previous slot + interval`, so they do not drift. */
  every(interval: string | number, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask
  every(interval: string | number, a: (() => void | Promise<void>) | DurableTaskOptions, b?: DurableTaskHandler): ScheduledTask {
    rejectTimeZone(a)
    if (typeof a !== 'function') return this.addDurable('interval', interval, a, b as DurableTaskHandler)
    return this.add(undefined, interval, undefined, a)
  }

  /** Add a one-shot delayed task. */
  delay(duration: string | number, fn: () => void | Promise<void>): ScheduledTask
  /**
   * Add a durable one-shot task: its run time is fixed when the id is first stored, so a
   * restart does not push it back (as long as the code registers the id again at boot).
   * After it runs, its row stays as a tombstone (registering the id again does not run it
   * again) until {@link forget} or `cancel()` removes it.
   */
  delay(duration: string | number, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask
  delay(duration: string | number, a: (() => void | Promise<void>) | DurableTaskOptions, b?: DurableTaskHandler): ScheduledTask {
    rejectTimeZone(a)
    if (typeof a !== 'function') return this.addDurable('once', duration, a, b as DurableTaskHandler)
    return this.add(undefined, undefined, duration, a)
  }

  /**
   * Register a durable task. On a running scheduler whose durable engine was not started
   * (nothing durable existed at start), the first durable task starts it: store failures
   * are then logged and retried by its poll, since there is no `start()` to reject.
   */
  private addDurable(kind: ScheduleKind, spec: string | number, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask {
    const task = this.durable.add(kind, spec, opts, fn)
    if (this.isRunning && !this.durable.isRunning) void this.durable.start(this.logger, { tolerant: true })
    return task
  }

  /**
   * Delete the stored schedule of a durable task id: an orphan (stored but no longer
   * registered in code), or a registered task, which is cancelled as well.
   */
  forget(id: string): Promise<void> {
    return this.durable.forget(id)
  }

  private add(
    cronExpr: string | undefined,
    interval: string | number | undefined,
    once: string | number | undefined,
    handler: () => void | Promise<void>,
    taskZone?: string,
  ): ScheduledTask {
    if (cronExpr !== undefined) assertCron(cronExpr)
    // The task's zone, else the scheduler's default; 'local' is the process zone.
    const zone = cronExpr !== undefined ? (taskZone ?? this.timeZone) : undefined
    const timeZone = zone !== undefined && zone !== 'local' ? zone : undefined
    const id = randomId('task')
    const runAt = once !== undefined
      ? new Date(Date.now() + parseDuration(once))
      : undefined

    const computeNextRun = (): Date | null => {
      if (cronExpr) return cronNextRun(cronExpr, new Date(), timeZone)
      if (interval !== undefined) {
        return new Date(Date.now() + parseDuration(interval))
      }
      if (runAt) return runAt
      return null
    }

    const task: InternalTask = {
      id,
      cron: cronExpr,
      interval: interval !== undefined ? String(interval) : undefined,
      runAt,
      isRecurring: cronExpr !== undefined || interval !== undefined,
      ...(timeZone !== undefined ? { timeZone } : {}),
      handler,
      generation: 0,
      nextRunDate: computeNextRun(),
      get nextRun() { return this.nextRunDate },
      computeNextRun,
      cancel: () => {
        if (task.timer) clearTimeout(task.timer)
        this.tasks.delete(id)
      },
    }

    this.tasks.set(id, task)
    this.schedule(task)
    return task
  }

  private schedule(task: InternalTask): void {
    if (!this.isRunning) return
    if (!this.tasks.has(task.id)) return
    if (task.timer) clearTimeout(task.timer)
    const next = task.computeNextRun()
    if (!next) return
    task.nextRunDate = next
    const generation = ++task.generation
    this.arm(task, next.getTime(), generation)
  }

  /**
   * Arm the timer of `task` for `at`. Node clamps a delay above 2^31-1 ms (~24.8 days) to
   * 1 ms, so a far run (a quarterly cron, `delay('40d')`) waits in chunks and rechecks
   * the clock before running the handler.
   */
  private arm(task: InternalTask, at: number, generation: number): void {
    const remaining = at - Date.now()
    if (remaining > MAX_TIMER_MS) {
      task.timer = setTimeout(() => {
        task.timer = undefined
        if (task.generation === generation && this.isRunning && this.tasks.has(task.id)) this.arm(task, at, generation)
      }, MAX_TIMER_MS)
      return
    }
    const delayMs = Math.max(0, remaining)
    task.timer = setTimeout(async () => {
      task.timer = undefined
      // A one-shot task is done the moment it fires: a stop()/start() cycle while its
      // handler runs must not schedule it again (start() only reschedules known tasks).
      if (!task.isRecurring) this.tasks.delete(task.id)
      try {
        await task.handler()
      } catch (err) {
        this.logger?.error?.({ err, taskId: task.id }, 'scheduled task failed')
      }
      // stop()/start() while the handler ran already gave this task a new timer
      // (a newer generation): rescheduling here as well would fork a second chain.
      if (!task.isRecurring || task.generation !== generation) return
      // Reschedule while running; if stop() landed mid-handler, KEEP the definition
      // (pause-not-delete) so start() resumes it.
      if (this.isRunning && this.tasks.has(task.id)) this.schedule(task)
    }, delayMs)
  }
}

/** Longest delay `setTimeout` honours (2^31-1 ms); longer ones fire after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1
