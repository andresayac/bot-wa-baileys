/**
 * Durable tasks of the {@link Scheduler} (internal): tasks registered with an `id` keep
 * their schedule in a {@link ScheduleStore}, so it survives restarts, and each occurrence
 * is claimed under a fenced lease so only one replica runs it.
 *
 * Flow per task:
 * - activation (at start, or on registration while running): `register()` keeps the stored
 *   `nextRunAt` when the spec is unchanged.
 * - fire (timer at `nextRunAt`, or the poll): `claimDue` -> handler (lease renewed every
 *   third of `leaseMs`) -> `complete` with the next slot. A failed claim means another
 *   replica runs it or it is not due yet: re-read the record and follow it.
 * - missed runs are decided per claim, from the stored state only (so every replica agrees
 *   whatever it saw before): a claimed slot overdue by more than the grace period (`tickMs`,
 *   plus twice `leaderTtlMs` with a leader lease) was missed, unless the record still carried
 *   the lease of a runner that died on that very slot: then the slot is retried as itself
 *   and the slots after it go through the policy. A catch-up runs every missed slot under
 *   ONE claim (committed once at the end), so no other replica can interleave.
 * - leadership (`lease`) is an optimisation: the leader claims on time; a follower steps in
 *   for an occurrence left overdue for `leaderTtlMs` (a task only it registered, a failover).
 * - poll (`tickMs`): activates tasks whose registration failed, retries overdue
 *   occurrences (a crashed runner's lease expires) and backs off on store errors.
 */

import type { Logger } from 'pino'
import { isCoordinatorLease, type SchedulerLease } from '../coordination/lease.js'
import type { Leadership } from '../coordination/types.js'
import type { DurableTaskHandler, DurableTaskOptions, MissedRunPolicy, ScheduledTask } from '../core/types.js'
import { parseDuration } from '../utils/duration.js'
import { parseIdlePeriod, randomId } from '../utils/timers.js'
import { assertCron, cronNextRun } from './cron.js'
import {
  MemoryScheduleStore,
  prefixScheduleStore,
  type ClaimResult,
  type CompletePatch,
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
  /** A one-shot task that has run (its row is a tombstone): dropped from the registry. */
  done: boolean
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
  private readonly lease?: SchedulerLease
  private readonly leaderKey: string
  private readonly tickMs: number
  private readonly leaderTtlMs: number
  /** How overdue a claimed slot must be to count as missed. */
  private readonly graceMs: number
  private readonly now: () => number
  readonly owner: string
  private logger?: Logger
  private running = false
  private epoch = 0
  private poll?: ReturnType<typeof setInterval>
  private leader?: { token: number; until: number }
  /** The held leadership when {@link lease} is a `Coordinator` (renewed by the coordinator). */
  private leadership?: Leadership
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
    // With a Coordinator lease, the follower's grace defaults to the coordinator's own lease TTL.
    const coordinatorTtl = opts.lease && isCoordinatorLease(opts.lease)
      ? (opts.lease as { leaseMs?: unknown }).leaseMs
      : undefined
    this.leaderTtlMs = parseIdlePeriod(
      opts.leaderTtlMs ?? (typeof coordinatorTtl === 'number' && coordinatorTtl > 0 ? coordinatorTtl : 30_000),
      'scheduler.leaderTtlMs',
    )
    // With a leader lease, a follower only steps in after `leaderTtlMs`, and a dead leader's
    // lease takes up to `leaderTtlMs` to expire: neither delay makes a slot "missed".
    this.graceMs = this.tickMs + (this.lease ? 2 * this.leaderTtlMs : 0)
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
      // A finished one-shot is no longer registered, but cancel() still deletes its tombstone.
      if (this.entries.get(id) !== entry && !entry.done) return
      if (this.entries.get(id) === entry) this.entries.delete(id)
      entry.done = false
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
      done: false,
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

  /** Started (and not stopped since). */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * Start: register every durable task (missed-run policies are applied when an overdue
   * slot is claimed, after this resolves) and start the poll. Rejects when the store fails,
   * so a bot start rolls back instead of silently losing reminders.
   *
   * `tolerant` (a late start, when the first durable task is registered on a running
   * scheduler): store failures are logged and retried by the poll instead of rejecting.
   */
  async start(logger?: Logger, opts: { tolerant?: boolean } = {}): Promise<void> {
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
    try {
      await this.store.start?.()
      const records = await this.store.list()
      if (epoch !== this.epoch) return
      for (const rec of records) {
        if (this.entries.has(rec.id) || this.orphansLogged.has(rec.id)) continue
        this.orphansLogged.add(rec.id)
        this.logger?.warn?.(
          { taskId: rec.id },
          'durable task stored but not registered (orphan): it is kept, never run; delete it with bot.forgetTask(id) or scheduler.forget(id)',
        )
      }
      for (const entry of [...this.entries.values()]) {
        if (!opts.tolerant) await this.activate(entry, epoch)
        else await this.activate(entry, epoch).catch((err: unknown) => this.reportFailure(entry, err, 'registering'))
      }
    } catch (err) {
      if (!opts.tolerant) throw err
      this.logger?.error?.({ err }, 'durable scheduler: starting failed; the poll retries registering its tasks')
    }
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
      entry.running?.abort(new Error('scheduler stopped'))
    }
    const leader = this.leader
    this.leader = undefined
    const leadership = this.leadership
    this.leadership = undefined
    const onError = (err: unknown) => { this.logger?.warn?.({ err }, 'scheduler: releasing the leader lease failed') }
    if (leadership) return leadership.release().catch(onError)
    if (!leader || !this.lease || isCoordinatorLease(this.lease)) return undefined
    return this.lease.release(this.leaderKey, this.owner, leader.token).catch(onError)
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
      if (rec.nextRunAt === null) {
        this.finish(entry)
        this.logger?.info?.({ taskId: entry.id }, 'durable one-shot task already ran (tombstone): forget its id to schedule it again')
        return
      }
      this.arm(entry, rec.nextRunAt)
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
      if (!(await this.isLeader())) {
        // The leader runs what it knows on time. A follower steps in only for an occurrence
        // left overdue for `leaderTtlMs`: a task the leader does not have (a rolling deploy,
        // a task registered on this replica only) or a leader that died.
        if (!this.overdue(entry, this.leaderTtlMs)) return
        await this.follow(entry)
        if (!this.overdue(entry, this.leaderTtlMs)) return
      }
      // An overdue slot still leased (expired) to someone is a runner that died mid-run.
      let interrupted: number | undefined
      if (this.overdue(entry, this.graceMs)) {
        const rec = await this.store.get(entry.id)
        if (rec && rec.leaseOwner !== undefined && rec.nextRunAt !== null) interrupted = rec.nextRunAt
      }
      const now = this.now()
      const claim = await this.store.claimDue(entry.id, this.owner, now, entry.leaseMs)
      if (!claim) {
        await this.follow(entry)
      } else {
        const slot = claim.record.nextRunAt as number
        if (slot === interrupted) {
          // Retry the interrupted occurrence as itself; overdue slots after it are claimed
          // next, as missed.
          await this.runSlots(entry, claim, [slot], false, () => this.slotAfter(entry, slot))
        } else if (slot < now - this.graceMs) {
          await this.runMissed(entry, claim, slot, now)
        } else {
          await this.runSlots(entry, claim, [slot], false, (at) => this.nextAfter(entry, slot, at))
        }
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

  /** The last known slot of `entry` is overdue by more than `ms`. */
  private overdue(entry: DurableEntry, ms: number): boolean {
    return entry.nextRunAt !== null && entry.nextRunAt < this.now() - ms
  }

  /** Apply the missed-run policy to a claimed slot that no scheduler ran in time. */
  private async runMissed(entry: DurableEntry, claim: ClaimResult, first: number, now: number): Promise<void> {
    if (entry.missed === 'skip') {
      const next = this.nextAfter(entry, first, now)
      this.logger?.info?.({ taskId: entry.id, missedSlot: new Date(first).toISOString() }, 'durable task: missed occurrence skipped')
      if (await this.store.complete(entry.id, claim.fencingToken, { nextRunAt: next }, now)) this.committed(entry, next)
      else await this.follow(entry)
      return
    }
    if (entry.missed === 'run-once') {
      await this.runSlots(entry, claim, [first], true, (at) => this.nextAfter(entry, first, at))
      return
    }
    // catch-up: every missed slot in order, all under this one claim. A slot within the
    // grace period is not missed: it becomes the next slot, run normally.
    const missedBefore = now - this.graceMs
    const slots = [first]
    let following = this.slotAfter(entry, first)
    while (following !== null && following < missedBefore && slots.length < entry.maxCatchUp) {
      slots.push(following)
      following = this.slotAfter(entry, following)
    }
    const capped = following !== null && following < missedBefore
    if (capped) {
      this.logger?.warn?.(
        { taskId: entry.id, maxCatchUp: entry.maxCatchUp, firstSkipped: new Date(following as number).toISOString() },
        'durable task: catch-up capped at maxCatchUp; the remaining missed occurrences are skipped',
      )
    }
    const last = slots[slots.length - 1]
    const after = following
    await this.runSlots(entry, claim, slots, true, capped ? (at) => this.nextAfter(entry, last, at) : () => after)
  }

  /**
   * Run `slots` in order under one claim (its lease renewed throughout), then commit once
   * with `next(now)`. When the run is aborted between slots (stop, lost lease), the first
   * slot not run is committed instead, so a later claim resumes there. `true` when the
   * commit went through.
   */
  private async runSlots(
    entry: DurableEntry,
    claim: ClaimResult,
    slots: readonly number[],
    missed: boolean,
    next: (now: number) => number | null,
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
    let lastRunAt: number | undefined
    let status: 'ok' | 'error' = 'ok'
    let ran = 0
    try {
      for (const slot of slots) {
        if (ac.signal.aborted || this.entries.get(entry.id) !== entry) break
        lastRunAt = this.now()
        status = 'ok'
        const scheduledAt = new Date(slot)
        try {
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
        }
        ran++
      }
    } finally {
      clearInterval(renewal)
      if (entry.running === ac) entry.running = undefined
    }
    // Cancelled while running: its row is (being) deleted, nothing to commit.
    if (this.entries.get(entry.id) !== entry) return false
    const nextRunAt = ran < slots.length ? slots[ran] : next(this.now())
    const patch: CompletePatch = lastRunAt === undefined ? { nextRunAt } : { nextRunAt, lastRunAt, lastStatus: status }
    const ok = await this.store.complete(entry.id, token, patch, this.now())
    if (ok) {
      this.committed(entry, nextRunAt)
    } else {
      this.logger?.warn?.(
        { taskId: entry.id, fencingToken: token, scheduledAt: new Date(slots[0]).toISOString() },
        'durable task: lease lost while running; the occurrence may run twice (use run.occurrenceKey to deduplicate)',
      )
      await this.follow(entry)
    }
    return ok
  }

  /** A commit went through: track the next slot, and drop a one-shot task that has run. */
  private committed(entry: DurableEntry, next: number | null): void {
    entry.nextRunAt = next
    if (next === null) this.finish(entry)
  }

  /** A one-shot task whose row is a tombstone never runs again: stop tracking it. */
  private finish(entry: DurableEntry): void {
    if (this.entries.get(entry.id) !== entry) return
    this.entries.delete(entry.id)
    this.disarm(entry)
    entry.done = true
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
    if (isCoordinatorLease(lease)) {
      // The coordinator renews a held leadership itself; its signal aborts once it is lost.
      if (this.leadership && !this.leadership.signal.aborted) return true
      this.leadership = undefined
      const won = await lease.tryLead(this.leaderKey)
      if (!won) return false
      if (!this.running) {
        await won.release()
        return false
      }
      this.leadership = won
      return true
    }
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
