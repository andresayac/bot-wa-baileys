/**
 * Scheduler — cron-style + interval + one-shot tasks.
 *
 * Uses tiny in-process timing; not designed to survive restarts (yet).
 */

import type { Logger } from 'pino'
import type { ScheduledTask } from '../core/types.js'
import { parseDuration, randomId } from '../utils/timers.js'

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

  start(logger?: Logger): void {
    if (this.isRunning) return
    this.logger = logger
    this.isRunning = true
    for (const task of this.tasks.values()) this.schedule(task)
  }

  stop(): void {
    this.isRunning = false
    for (const t of this.tasks.values()) {
      if (t.timer) clearTimeout(t.timer)
      t.timer = undefined
    }
  }

  /** Add a cron-style task. */
  cron(cronExpr: string, fn: () => void | Promise<void>): ScheduledTask {
    return this.add(cronExpr, undefined, undefined, fn)
  }

  /** Add an interval task ("5 minutes", "1 hour", or ms). */
  every(interval: string | number, fn: () => void | Promise<void>): ScheduledTask {
    return this.add(undefined, interval, undefined, fn)
  }

  /** Add a one-shot delayed task. */
  delay(duration: string | number, fn: () => void | Promise<void>): ScheduledTask {
    return this.add(undefined, undefined, duration, fn)
  }

  private add(
    cronExpr: string | undefined,
    interval: string | number | undefined,
    once: string | number | undefined,
    handler: () => void | Promise<void>
  ): ScheduledTask {
    if (cronExpr !== undefined) assertCron(cronExpr)
    const id = randomId('task')
    const runAt = once !== undefined
      ? new Date(Date.now() + parseDuration(once))
      : undefined

    const computeNextRun = (): Date | null => {
      if (cronExpr) return cronNextRun(cronExpr)
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

/* =============================================================================
 * MINIMAL CRON PARSER — five fields: minute hour day-of-month month weekday.
 * Each field takes '*', a number, a range (1-5), a step (`*` + `/15`, 1-30/5, 5/15) or a
 * comma list of those; weekday 0 and 7 are Sunday. Every field must match (the
 * day-of-month/weekday OR rule of classic cron is not implemented). Names (mon, jan)
 * and macros (@daily) are rejected when the task is created.
 * (For full cron support, swap to a real parser like `cron-parser`.)
 * ========================================================================== */

/** Longest delay `setTimeout` honours (2^31-1 ms); longer ones fire after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1

const CRON_FIELDS = ['minute', 'hour', 'day-of-month', 'month', 'weekday'] as const
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/

/** Throw an actionable `TypeError` for an expression the minimal parser cannot run. */
function assertCron(expr: string): void {
  const parts = typeof expr === 'string' ? expr.trim().split(/\s+/) : []
  if (parts.length !== 5) {
    throw new TypeError(
      `Invalid cron expression "${String(expr)}": expected 5 fields (minute hour day-of-month month weekday), e.g. '0 9 * * 1-5'`,
    )
  }
  parts.forEach((part, i) => {
    if (!CRON_FIELD.test(part)) {
      throw new TypeError(
        `Invalid cron expression "${expr}": the ${CRON_FIELDS[i]} field "${part}" must use numbers, '*', ranges (1-5), steps (*/15) or lists (1,15)`,
      )
    }
  })
}

function cronNextRun(expr: string): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts

  // Start from next minute
  const next = new Date()
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  // Search far enough to cover monthly and annual expressions.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const candidate = new Date(next.getTime() + i * 60_000)
    if (matchesField(candidate.getMinutes(), m) &&
        matchesField(candidate.getHours(), h) &&
        matchesField(candidate.getDate(), dom) &&
        matchesField(candidate.getMonth() + 1, mon) &&
        matchesWeekday(candidate.getDay(), dow)) {
      return candidate
    }
  }
  return null
}

/** Weekday field: `0` and `7` both mean Sunday (standard cron). */
function matchesWeekday(day: number, expr: string): boolean {
  return matchesField(day, expr) || (day === 0 && matchesField(7, expr))
}

function matchesField(actual: number, expr: string): boolean {
  if (expr === '*') return true
  // ranges & lists
  for (const part of expr.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : parseInt(stepText, 10)
    if (!Number.isInteger(step) || step <= 0) continue
    let lo: number
    let hi: number
    if (range === '*') {
      lo = 0
      hi = Number.POSITIVE_INFINITY
    } else if (range.includes('-')) {
      ;[lo, hi] = range.split('-').map((n) => parseInt(n, 10))
    } else {
      lo = parseInt(range, 10)
      // `5/15` (start/step without a range) runs from 5 to the end of the field.
      hi = stepText === undefined ? lo : Number.POSITIVE_INFINITY
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue
    if (actual >= lo && actual <= hi && (actual - lo) % step === 0) return true
  }
  return false
}
