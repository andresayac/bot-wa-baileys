/**
 * Tracing seam of the {@link Scheduler} (`BotConfig.telemetry`): each run of a scheduled
 * task — a plain in-memory task or one occurrence of a durable task — goes through
 * {@link TaskTraceHooks.run}, which the bot implements as a root `bot.task` span (see
 * telemetry/tasks.ts). Without telemetry no hook is installed and tasks run exactly as
 * before.
 */
import type { ScheduleKind } from './ScheduleStore.js'

/** What a task run's span describes (no handler data: ids, specs and scheduling facts only). */
export interface TaskRunInfo {
  /** Task id: the durable id (as registered, without the store namespace) or the plain task's random id. */
  id: string
  kind: ScheduleKind
  /** Registered with a durable id (stored schedule, claimed under a fenced lease). */
  durable: boolean
  /** Cron expression (cron tasks). */
  cron?: string
  /** Interval in ms (interval tasks). */
  intervalMs?: number
  /** IANA zone of the cron fields, when set. */
  timeZone?: string
  /** Durable: the slot this run is for (epoch ms). */
  scheduledAt?: number
  /** Durable: the slot was missed and runs late (missed-run policy `run-once`/`catch-up`). */
  missed?: boolean
  /** Durable: fencing token of the claim this run holds. */
  fencingToken?: number
  /**
   * Durable: how this replica came to run it — `'leader'` (holds the scheduler leadership),
   * `'follower'` (stepped in for an occurrence the leader left overdue) or `'single'` (no
   * leader lease configured).
   */
  role?: 'leader' | 'follower' | 'single'
  /** Durable: this replica's scheduler owner id (`SchedulerOptions.owner`). */
  owner?: string
}

/** Implemented by the bot when tracing is on (`Scheduler.trace`). */
export interface TaskTraceHooks {
  /**
   * Run one task run inside its span. Must call `fn` synchronously and return its value
   * (or promise) unchanged; a throw or rejection is recorded and re-thrown.
   */
  run<T>(info: TaskRunInfo, fn: () => T): T
}

const UNTRACED = Symbol('botwa.untracedTask')

/** Internal: mark a plain task handler (the bot's per-chat idle watchers) as never traced. */
export function untracedTask<F extends () => void | Promise<void>>(fn: F): F {
  const wrapped = (() => fn()) as F
  ;(wrapped as unknown as Record<symbol, true>)[UNTRACED] = true
  return wrapped
}

/** `true` for a handler marked with {@link untracedTask}. */
export function isUntraced(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[UNTRACED] === true
}
