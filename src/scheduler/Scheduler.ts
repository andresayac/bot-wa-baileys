/**
 * Scheduler — cron-style + interval + one-shot tasks.
 *
 * Uses tiny in-process timing; not designed to survive restarts (yet).
 */

import type { Logger } from 'pino'
import type { ScheduledTask } from '../core/types'
import { parseDuration, randomId } from '../utils/timers'

interface InternalTask extends ScheduledTask {
  handler: () => void | Promise<void>
  timer?: NodeJS.Timeout
  nextRunDate: Date | null
  computeNextRun(): Date | null
}

export class Scheduler {
  private tasks = new Map<string, InternalTask>()
  private logger?: Logger
  private isRunning = false

  start(logger?: Logger): void {
    this.logger = logger
    this.isRunning = true
  }

  stop(): void {
    this.isRunning = false
    for (const t of this.tasks.values()) {
      if (t.timer) clearTimeout(t.timer)
    }
    this.tasks.clear()
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
    const id = randomId('task')

    const computeNextRun = (): Date | null => {
      if (cronExpr) return cronNextRun(cronExpr)
      if (interval !== undefined) {
        return new Date(Date.now() + parseDuration(interval))
      }
      if (once !== undefined) {
        return new Date(Date.now() + parseDuration(once))
      }
      return null
    }

    const task: InternalTask = {
      id,
      cron: cronExpr,
      interval: interval ? String(interval) : undefined,
      runAt: once ? new Date(Date.now() + parseDuration(once)) : undefined,
      isRecurring: cronExpr !== undefined || interval !== undefined,
      handler,
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
    const next = task.computeNextRun()
    if (!next) return
    task.nextRunDate = next
    const delayMs = Math.max(0, next.getTime() - Date.now())
    task.timer = setTimeout(async () => {
      try {
        await task.handler()
      } catch (err) {
        this.logger?.error?.({ err, taskId: task.id }, 'scheduled task failed')
      }
      if (task.isRecurring) this.schedule(task)
      else this.tasks.delete(task.id)
    }, delayMs)
  }
}

/* =============================================================================
 * MINIMAL CRON PARSER — supports: minute hour day month weekday
 * Supports the '*' wildcard and a single numeric value per field.
 * (For full cron support, swap to a real parser like `cron-parser`.)
 * ========================================================================== */

function cronNextRun(expr: string): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts

  // Start from next minute
  const next = new Date()
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  // Brute-force search up to 7 days ahead
  for (let i = 0; i < 7 * 24 * 60; i++) {
    const candidate = new Date(next.getTime() + i * 60_000)
    if (matchesField(candidate.getMinutes(), m) &&
        matchesField(candidate.getHours(), h) &&
        matchesField(candidate.getDate(), dom) &&
        matchesField(candidate.getMonth() + 1, mon) &&
        matchesField(candidate.getDay(), dow)) {
      return candidate
    }
  }
  return null
}

function matchesField(actual: number, expr: string): boolean {
  if (expr === '*') return true
  // ranges & lists
  for (const part of expr.split(',')) {
    if (part.includes('/')) {
      const [base, step] = part.split('/')
      const stepN = parseInt(step, 10)
      let min = base === '*' ? 0 : parseInt(base, 10)
      if (isNaN(min)) min = 0
      if (actual >= min && (actual - min) % stepN === 0) return true
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map((n) => parseInt(n, 10))
      if (actual >= lo && actual <= hi) return true
    } else {
      if (actual === parseInt(part, 10)) return true
    }
  }
  return false
}
