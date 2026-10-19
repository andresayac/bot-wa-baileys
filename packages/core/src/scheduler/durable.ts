/**
 * Durable tasks of the {@link Scheduler} (internal): tasks registered with an `id` keep
 * their schedule in a {@link ScheduleStore}, so it survives restarts, and each occurrence
 * is claimed under a fenced lease so only one replica runs it.
 *
 * Flow per task:
 * - activation (at start, or on registration while running): `register()` keeps the stored
 *   `nextRunAt` when the spec is unchanged; an occurrence overdue by more than the grace
 *   period gets the task's missed-run policy on its first fire.
 * - fire (timer at `nextRunAt`, or the poll): `claimDue` -> handler (lease renewed every
 *   third of `leaseMs`) -> `complete` with the next slot. A failed claim means another
 *   replica runs it or it is not due yet: re-read the record and follow it.
 * - poll (`tickMs`): activates tasks whose registration failed, retries overdue
 *   occurrences (a crashed runner's lease expires) and backs off on store errors.
 */

import type { Logger } from 'pino'
import type { LeaseProvider } from '../coordination/lease.js'
import type { DurableTaskHandler, DurableTaskOptions, MissedRunPolicy, ScheduledTask } from '../core/types.js'
import { parseDuration } from '../utils/duration.js'
import { parseIdlePeriod, randomId } from '../utils/timers.js'
import { assertCron, cronNextRun } from './cron.js'
import {
  MemoryScheduleStore,
  prefixScheduleStore,
  type ClaimResult,
  type ScheduleKind,
  type ScheduleStore,
  type SchedulerOptions,
} from './ScheduleStore.js'

/** Longest delay `setTimeout` honours (2^31-1 ms); longer ones fire after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1
const MISSED_POLICIES: readonly MissedRunPolicy[] = ['skip', 'run-once', 'catch-up']
const MAX_BACKOFF_MS = 60_000

interface DurableEntry {
  readonly id: string
  readonly kind: ScheduleKind
  readonly spec: string
  readonly cron?: string
  /** Interval or one-shot delay, in ms. */
  readonly ms?: number
  readonly missed: MissedRunPolicy
  readonly maxCatchUp: number
  readonly leaseMs: number
  readonly handler: DurableTaskHandler
  /** Last known `nextRunAt` of the stored record. */
  nextRunAt: number | null
  /** Registered in the store during the current run of the scheduler. */
  activated: boolean
  /** Pending `register()`; `cancel()` deletes the row only after it settles. */
  activation?: Promise<void>
  /** The next fire applies the missed-run policy (the stored slot was overdue at activation). */
  missedCheck: boolean
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
  generation: number
  failures: number
  retryAt: number
  running?: AbortController
  readonly facade: ScheduledTask
}

/** Options of the durable engine: the public {@link SchedulerOptions} plus the bot's store namespace. */
export interface DurableSchedulerOptions extends SchedulerOptions {
  /** Prefix applied to every task id and to the leader lease key (the bot's store namespace). */
  scope?: string
}

export class DurableScheduler {
  private readonly entries = new Map<string, DurableEntry>()
  private readonly store: ScheduleStore
  private readonly explicitStore: boolean
  private readonly lease?: LeaseProvider
  private readonly leaderKey: string
  private readonly tickMs: number
  private readonly leaderTtlMs: number
  private readonly now: () => number
  readonly owner: string
  private logger?: Logger
  private running = false
  private epoch = 0
  private poll?: ReturnType<typeof setInterval>
  private leader?: { token: number; until: number }
  private warnedMemory = false
  private readonly orphansLogged = new Set<string>()

  constructor(opts: DurableSchedulerOptions = {}) {
    const scope = opts.scope ?? ''
    if (opts.store !== undefined) assertScheduleStore(opts.store)
    this.explicitStore = opts.store !== undefined
    this.store = prefixScheduleStore(opts.store ?? new MemoryScheduleStore(), scope)
    this.lease = opts.lease
    this.leaderKey = `${scope}scheduler:leader`
    this.owner = opts.owner ?? randomId('replica')
    this.tickMs = parseIdlePeriod(opts.tickMs ?? 1000, 'scheduler.tickMs')
    this.leaderTtlMs = parseIdlePeriod(opts.leaderTtlMs ?? 30_000, 'scheduler.leaderTtlMs')
    this.now = opts.now ?? Date.now
  }

  /** Register a durable task (validated synchronously). */
  add(kind: ScheduleKind, spec: string | number, opts: DurableTaskOptions, handler: DurableTaskHandler): ScheduledTask {
    if (typeof handler !== 'function') throw new TypeError('A durable task needs a handler function as its last argument')
    if (opts === null || typeof opts !== 'object') throw new TypeError('Durable task options must be an object with an `id`')
    const id = opts.id
    if (typeof id !== 'string' || id.trim() === '' || /[\u0000-\u001f]/.test(id)) {
      throw new TypeError(`A durable task id must be a non-empty string without control characters, got ${JSON.stringify(id)}`)
    }
    if (this.entries.has(id)) {
      throw new TypeError(`A durable task with id "${id}" is already registered (cancel() it before registering it again)`)
    }
    const missed = opts.missed ?? 'skip'
    if (!MISSED_POLICIES.includes(missed)) {
      throw new TypeError(`Durable task "${id}": missed must be one of ${MISSED_POLICIES.join(', ')}, got ${JSON.stringify(missed)}`)
    }
    const maxCatchUp = opts.maxCatchUp ?? 10
    if (!(Number.isInteger(maxCatchUp) && maxCatchUp > 0)) {
      throw new RangeError(`Durable task "${id}": maxCatchUp must be a positive integer, got ${String(maxCatchUp)}`)
    }
    const leaseMs = parseIdlePeriod(opts.leaseMs ?? 60_000, `durable task "${id}" leaseMs`)

    let cron: string | undefined
    let ms: number | undefined
    let storedSpec: string
    if (kind === 'cron') {
      assertCron(spec as string)
      cron = (spec as string).trim().split(/\s+/).join(' ')
      storedSpec = cron
    } else {
      ms = parseDuration(spec)
      if (!(Number.isFinite(ms) && ms > 0)) {
        throw new RangeError(`Durable task "${id}" needs a positive, finite duration, got ${JSON.stringify(spec)}`)
      }
      storedSpec = String(ms)
    }

    const cancel = (): void => {
      if (this.entries.get(id) !== entry) return
      this.entries.delete(id)
      this.disarm(entry)
      const pending = entry.activation ?? Promise.resolve()
      void pending
        .catch(() => undefined)
        .then(() => this.store.delete(id))
        .catch((err: unknown) => this.logger?.error?.({ err, taskId: id }, 'durable task: deleting the stored schedule failed'))
    }
    const entry: DurableEntry = {
      id,
      kind,
      spec: storedSpec,
      cron,
      ms,
      missed,
      maxCatchUp,
      leaseMs,
      handler,
      nextRunAt: null,
      activated: false,
      missedCheck: false,
      busy: false,
      generation: 0,
      failures: 0,
      retryAt: 0,
      facade: {
        id,
        cron,
        interval: kind === 'interval' ? (typeof spec === 'number' ? spec : String(spec)) : undefined,
        get runAt() { return kind === 'once' && entry.nextRunAt !== null ? new Date(entry.nextRunAt) : undefined },
        get nextRun() { return entry.nextRunAt === null ? null : new Date(entry.nextRunAt) },
        isRecurring: kind !== 'once',
        durable: true,
        cancel,
      },
    }
    this.entries.set(id, entry)
    if (this.running) {
      const epoch = this.epoch
      void this.activate(entry, epoch).catch((err: unknown) => this.reportFailure(entry, err, 'registering'))
    }
    return entry.facade
  }

  /** Has anything to start: durable tasks, or an explicit store (orphans are listed). */
  get hasWork(): boolean {
    return this.entries.size > 0 || this.explicitStore
  }

  /**
   * Start: register every durable task (missed-run policies are applied on their first
   * fire, after this resolves) and start the poll. Rejects when the store fails, so a bot
   * start rolls back instead of silently losing reminders.
   */
  async start(logger?: Logger): Promise<void> {
    if (this.running) return
    this.logger = logger ?? this.logger
    this.running = true
    const epoch = ++this.epoch
    if (!this.explicitStore && this.entries.size > 0 && !this.warnedMemory) {
      this.warnedMemory = true
      this.logger?.warn?.(
        'durable scheduler tasks use an in-memory ScheduleStore: their schedule does not survive a restart (set BotConfig.scheduler.store)',
      )
    }
    await this.store.start?.()
    const records = await this.store.list()
    if (epoch !== this.epoch) return
    for (const rec of records) {
      if (this.entries.has(rec.id) || this.orphansLogged.has(rec.id)) continue
      this.orphansLogged.add(rec.id)
      this.logger?.warn?.({ taskId: rec.id }, 'durable task stored but not registered (orphan): it is kept, never run; delete it with forget()')
    }
    for (const entry of [...this.entries.values()]) await this.activate(entry, epoch)
    if (epoch !== this.epoch) return
    this.poll = setInterval(() => this.tick(), this.tickMs)
  }

  /**
   * Pause: timers stop, running handlers see `signal` abort; stored rows are kept. Returns
   * a promise (that never rejects) only when the leader lease has to be released, so the
   * caller can wait for it before closing the lease backend's connection.
   */
  stop(): Promise<void> | undefined {
    this.running = false
    this.epoch++
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
    for (const entry of this.entries.values()) {
      this.disarm(entry)
      entry.activated = false
      entry.missedCheck = false
      entry.running?.abort(new Error('scheduler stopped'))
    }
    const leader = this.leader
    this.leader = undefined
    if (!leader || !this.lease) return undefined
    return this.lease.release(this.leaderKey, this.owner, leader.token)
      .catch((err: unknown) => { this.logger?.warn?.({ err }, 'scheduler: releasing the leader lease failed') })
  }

  /** Delete a stored schedule (an orphan, or a registered task, which is cancelled too). */
  async forget(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      this.entries.delete(id)
      this.disarm(entry)
      await entry.activation?.catch(() => undefined)
    }
    this.orphansLogged.delete(id)
    await this.store.delete(id)
  }

  /* ---------------------------------------------------------------------- */

  private activate(entry: DurableEntry, epoch: number): Promise<void> {
    const run = async (): Promise<void> => {
      const now = this.now()
      const rec = await this.store.register(
        { id: entry.id, kind: entry.kind, spec: entry.spec, nextRunAt: this.initialNext(entry, now) },
        now,
      )
      if (epoch !== this.epoch || this.entries.get(entry.id) !== entry) return
      entry.activated = true
      entry.failures = 0
      entry.retryAt = 0
      entry.nextRunAt = rec.nextRunAt
      if (rec.nextRunAt === null) return
      entry.missedCheck = rec.nextRunAt < now - this.tickMs
      this.arm(entry, entry.missedCheck ? now : rec.nextRunAt)
    }
    const p = run()
    entry.activation = p
    return p
  }

  private tick(): void {
    if (!this.running) return
    const now = this.now()
    const epoch = this.epoch
    for (const entry of this.entries.values()) {
      if (entry.busy || entry.retryAt > now) continue
      if (!entry.activated) {
        entry.busy = true
        this.activate(entry, epoch)
          .catch((err: unknown) => this.reportFailure(entry, err, 'registering'))
          .finally(() => { entry.busy = false })
        continue
      }
      if (entry.nextRunAt !== null && entry.nextRunAt <= now) void this.fire(entry)
    }
  }

  private async fire(entry: DurableEntry): Promise<void> {
    if (entry.busy || !this.running || this.entries.get(entry.id) !== entry || !entry.activated) return
    entry.busy = true
    const epoch = this.epoch
    try {
      if (!(await this.isLeader())) return
      const now = this.now()
      const claim = await this.store.claimDue(entry.id, this.owner, now, entry.leaseMs)
      const missedCheck = entry.missedCheck
      entry.missedCheck = false
      if (!claim) {
        await this.follow(entry)
      } else if (missedCheck) {
        await this.runMissed(entry, claim, now)
      } else {
        const slot = claim.record.nextRunAt as number
        await this.runOccurrence(entry, claim, slot, false, this.nextAfter(entry, slot, now))
      }
      entry.failures = 0
      entry.retryAt = 0
    } catch (err) {
      this.reportFailure(entry, err, 'running')
    } finally {
      entry.busy = false
      if (epoch === this.epoch && this.running && this.entries.get(entry.id) === entry && entry.nextRunAt !== null) {
        const at = entry.nextRunAt
        if (at > this.now()) this.arm(entry, at)
      }
    }
  }

  private async runMissed(entry: DurableEntry, claim: ClaimResult, now: number): Promise<void> {
    const first = claim.record.nextRunAt as number
    if (entry.missed === 'skip') {
      const next = this.nextAfter(entry, first, now)
      this.logger?.info?.({ taskId: entry.id, missedSlot: new Date(first).toISOString() }, 'durable task: missed occurrence skipped')
      if (await this.store.complete(entry.id, claim.fencingToken, { nextRunAt: next }, now)) entry.nextRunAt = next
      else await this.follow(entry)
      return
    }
    if (entry.missed === 'run-once') {
      await this.runOccurrence(entry, claim, first, true, this.nextAfter(entry, first, now))
      return
    }
    // catch-up: every missed slot in order, each under its own claim.
    let current: ClaimResult | null = claim
    let slot = first
    for (let count = 1; current; count++) {
      const following = this.slotAfter(entry, slot)
      const caughtUp = following === null || following > now
      const capped = !caughtUp && count >= entry.maxCatchUp
      if (capped) {
        this.logger?.warn?.(
          { taskId: entry.id, maxCatchUp: entry.maxCatchUp, firstSkipped: new Date(following as number).toISOString() },
          'durable task: catch-up capped at maxCatchUp; the remaining missed occurrences are skipped',
        )
      }
      const last = caughtUp || capped
      const next = last ? this.nextAfter(entry, slot, Math.max(now, this.now())) : following
      const ok = await this.runOccurrence(entry, current, slot, true, next)
      if (last || !ok || !this.running || this.entries.get(entry.id) !== entry) return
      current = await this.store.claimDue(entry.id, this.owner, this.now(), entry.leaseMs)
      if (!current) { await this.follow(entry); return }
      slot = current.record.nextRunAt as number
    }
  }

  /** Run one occurrence under its claim; `true` when `complete()` committed it. */
  private async runOccurrence(
    entry: DurableEntry,
    claim: ClaimResult,
    slot: number,
    missed: boolean,
    next: number | null,
  ): Promise<boolean> {
    const token = claim.fencingToken
    const ac = new AbortController()
    entry.running = ac
    const renewal = setInterval(() => {
      this.store.renew(entry.id, token, this.now() + entry.leaseMs).then(
        (ok) => { if (!ok && !ac.signal.aborted) ac.abort(new Error('scheduler lease lost')) },
        (err: unknown) => this.logger?.warn?.({ err, taskId: entry.id }, 'durable task: lease renewal failed'),
      )
    }, Math.max(1, Math.floor(entry.leaseMs / 3)))
    renewal.unref?.()
    const startedAt = this.now()
    let status: 'ok' | 'error' = 'ok'
    try {
      const scheduledAt = new Date(slot)
      await entry.handler({
        taskId: entry.id,
        scheduledAt,
        occurrenceKey: `${entry.id}@${scheduledAt.toISOString()}`,
        fencingToken: token,
        missed,
        signal: ac.signal,
      })
    } catch (err) {
      status = 'error'
      this.logger?.error?.({ err, taskId: entry.id }, 'scheduled task failed')
    } finally {
      clearInterval(renewal)
      if (entry.running === ac) entry.running = undefined
    }
    // Cancelled while running: its row is (being) deleted — nothing to commit.
    if (this.entries.get(entry.id) !== entry) return false
    const ok = await this.store.complete(entry.id, token, { nextRunAt: next, lastRunAt: startedAt, lastStatus: status }, this.now())
    if (ok) {
      entry.nextRunAt = next
    } else {
      this.logger?.warn?.(
        { taskId: entry.id, fencingToken: token, scheduledAt: new Date(slot).toISOString() },
        'durable task: lease lost while running; the occurrence may run twice (use run.occurrenceKey to deduplicate)',
      )
      await this.follow(entry)
    }
    return ok
  }

  /** Re-read the stored record (another replica ran or holds the occurrence). */
  private async follow(entry: DurableEntry): Promise<void> {
    const rec = await this.store.get(entry.id)
    if (this.entries.get(entry.id) !== entry) return
    if (!rec) {
      // Deleted elsewhere while registered here: register it again on the next tick.
      entry.activated = false
      return
    }
    entry.nextRunAt = rec.nextRunAt
  }

  private async isLeader(): Promise<boolean> {
    const lease = this.lease
    if (!lease) return true
    const now = this.now()
    const ttl = this.leaderTtlMs
    if (this.leader && this.leader.until - now > ttl / 3) return true
    if (this.leader) {
      if (await lease.renew(this.leaderKey, this.owner, this.leader.token, ttl)) {
        this.leader.until = now + ttl
        return true
      }
      this.leader = undefined
    }
    const grant = await lease.acquire(this.leaderKey, this.owner, ttl)
    if (!grant) return false
    if (!this.running) {
      await lease.release(this.leaderKey, this.owner, grant.token)
      return false
    }
    this.leader = { token: grant.token, until: now + ttl }
    return true
  }

  private reportFailure(entry: DurableEntry, err: unknown, what: string): void {
    entry.failures++
    entry.retryAt = this.now() + Math.min(this.tickMs * 2 ** entry.failures, MAX_BACKOFF_MS)
    this.logger?.error?.({ err, taskId: entry.id, failures: entry.failures }, `durable task: ${what} failed; retrying`)
  }

  /* -------------------------------- slots -------------------------------- */

  private initialNext(entry: DurableEntry, now: number): number | null {
    if (entry.kind === 'cron') return cronNextRun(entry.cron as string, new Date(now))?.getTime() ?? null
    return now + (entry.ms as number)
  }

  /** The slot right after `slot` (`null` for a one-shot task). */
  private slotAfter(entry: DurableEntry, slot: number): number | null {
    if (entry.kind === 'once') return null
    if (entry.kind === 'cron') return cronNextRun(entry.cron as string, new Date(slot))?.getTime() ?? null
    return slot + (entry.ms as number)
  }

  /** The first slot after both `slot` and `now` (drift-free for intervals). */
  private nextAfter(entry: DurableEntry, slot: number, now: number): number | null {
    if (entry.kind === 'once') return null
    if (entry.kind === 'cron') return cronNextRun(entry.cron as string, new Date(Math.max(slot, now)))?.getTime() ?? null
    const ms = entry.ms as number
    const steps = now < slot ? 1 : Math.floor((now - slot) / ms) + 1
    return slot + steps * ms
  }

  /* -------------------------------- timers ------------------------------- */

  private disarm(entry: DurableEntry): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.generation++
  }

  /** Fire `entry` at `at`, waiting in chunks past the 2^31-1 ms `setTimeout` limit. */
  private arm(entry: DurableEntry, at: number): void {
    this.disarm(entry)
    const generation = entry.generation
    const live = (): boolean => entry.generation === generation && this.running && this.entries.get(entry.id) === entry
    const step = (): void => {
      const remaining = at - this.now()
      if (remaining > MAX_TIMER_MS) {
        entry.timer = setTimeout(() => { entry.timer = undefined; if (live()) step() }, MAX_TIMER_MS)
        return
      }
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        if (live()) void this.fire(entry)
      }, Math.max(0, remaining))
    }
    step()
  }
}

const STORE_METHODS = ['get', 'register', 'claimDue', 'renew', 'complete', 'delete', 'list'] as const

/** Fail fast (at construction) on a `scheduler.store` that is not a {@link ScheduleStore}. */
function assertScheduleStore(store: unknown): void {
  const missing = STORE_METHODS.filter((m) => typeof (store as Record<string, unknown> | null)?.[m] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(
      `scheduler.store must implement ScheduleStore (missing: ${missing.join(', ')}); use e.g. SQLiteStore#schedules() or RedisStore#schedules()`,
    )
  }
}
