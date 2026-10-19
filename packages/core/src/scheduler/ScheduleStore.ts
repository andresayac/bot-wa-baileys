/**
 * ScheduleStore: the persistence contract of durable scheduler tasks.
 *
 * Only the schedule's STATE is persisted (spec, next/last run, lease); handlers live in
 * code and are matched by task id when the scheduler starts. Every mutating call is a
 * single atomic compare-and-set so N replicas can share one store: `claimDue` is the
 * per-occurrence lease, and its fencing token (bumped on every claim) rejects the late
 * `renew`/`complete` of a runner whose lease was taken over.
 *
 * {@link MemoryScheduleStore} is the reference implementation of the contract; the
 * shared suite `test-utils/schedule-store-conformance.ts` runs against every backend.
 */

import type { LeaseProvider, SchedulerLease } from '../coordination/lease.js'

/** Kind of a durable task. */
export type ScheduleKind = 'cron' | 'interval' | 'once'

/** Persisted state of one durable task. */
export interface ScheduleRecord {
  id: string
  kind: ScheduleKind
  /**
   * Cron expression, interval in ms, or one-shot delay in ms (as a string). A cron task
   * with a time zone stores `TZ=<zone> <cron>` (an opaque string for the store).
   */
  spec: string
  /** Epoch ms of the next occurrence; `null` once a one-shot task has run (a tombstone). */
  nextRunAt: number | null
  lastRunAt?: number
  lastStatus?: 'ok' | 'error'
  /**
   * Bumped by every successful {@link ScheduleStore.claimDue}; starts at 0 for a new id.
   * Never goes backwards for an id, even across `delete` and a new `register`.
   */
  fencingToken: number
  leaseOwner?: string
  leaseUntil?: number
  updatedAt: number
}

/** A successful claim: the record as claimed, and the claim's fencing token. */
export interface ClaimResult {
  record: ScheduleRecord
  fencingToken: number
}

/** What {@link ScheduleStore.complete} writes. Omitted `lastRunAt`/`lastStatus` keep their stored values. */
export interface CompletePatch {
  nextRunAt: number | null
  lastRunAt?: number
  lastStatus?: 'ok' | 'error'
}

export interface ScheduleStore {
  /** Optional setup (schema, connection) — called by the scheduler before first use. Must be idempotent. */
  start?(): Promise<void>
  get(id: string): Promise<ScheduleRecord | null>
  /**
   * Insert the task if absent. If it exists with the same `kind` and `spec`, keep it
   * untouched (that is how a restart keeps its `nextRunAt`); if either differs, overwrite
   * `kind`, `spec` and `nextRunAt` with the given ones (the fencing token is kept). Returns
   * the stored record.
   */
  register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord>
  /**
   * Atomic claim: succeeds only when `nextRunAt !== null && nextRunAt <= now` and the
   * record has no live lease (`leaseUntil` absent or `<= now`). Then it sets
   * `leaseOwner = owner`, `leaseUntil = now + leaseMs` and increments `fencingToken`.
   * Returns `null` otherwise (not due, leased elsewhere, or unknown id).
   */
  claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null>
  /** Set `leaseUntil` only if `fencingToken` still matches; `false` means the lease was lost. */
  renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean>
  /**
   * Commit an occurrence only if `fencingToken` still matches: write the patch, clear the
   * lease and set `updatedAt = now`. `false` when stale (claimed again since) or deleted.
   */
  complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean>
  /**
   * Remove the record. The id's fencing token is kept as a high-water mark: a later
   * `register()` of the same id starts from it, so tokens never go backwards per id.
   */
  delete(id: string): Promise<void>
  /** Every stored record (orphans included), in no particular order. */
  list(): Promise<ScheduleRecord[]>
}

/**
 * Options of a {@link Scheduler} (and of `BotConfig.scheduler`). They only affect
 * durable tasks — plain `schedule/every/delay(spec, fn)` tasks stay in-memory.
 */
export interface SchedulerOptions {
  /**
   * Where durable tasks persist their state. Default: an in-memory store, which keeps
   * the in-process semantics (nothing survives a restart; a warning is logged once).
   * Use the `schedules()` of `SQLiteStore`, `RedisStore`, `PostgresStore`, `MysqlStore`
   * or `MongoStore` (or any implementation).
   */
  store?: ScheduleStore
  /**
   * Optional leadership, which saves store round-trips with many replicas: the replica
   * holding the `scheduler:leader` lease claims occurrences on time; the others only claim
   * one left overdue for `leaderTtlMs` (a task only they registered, or a dead leader).
   * Correctness never depends on it: per-occurrence claims are fenced anyway.
   *
   * Either a fenced {@link LeaseProvider} (`MemoryLeaseProvider`, `RedisStore#leases()`)
   * or a multi-replica `Coordinator` (`RedisCoordinator`, `MemoryCoordinator`), whose
   * `tryLead` leadership is used. A bot with `BotConfig.coordination` defaults to its
   * coordinator here.
   */
  lease?: SchedulerLease
  /** This process's lease-owner id. Default: a random id per scheduler. */
  owner?: string
  /**
   * Poll period for durable tasks (duration or ms, default `'1s'`): picks up occurrences
   * whose runner crashed (once its lease expires) and retries after store errors. It is
   * also the grace period (plus twice `leaderTtlMs` with a `lease`): a slot claimed later
   * than that after it fell due counts as missed (no replica ran it in time).
   */
  tickMs?: string | number
  /**
   * TTL of the `scheduler:leader` lease when {@link lease} is set (duration or ms, default
   * `'30s'`). With a `Coordinator` lease the coordinator renews the leadership itself;
   * this is then only the follower's grace before it steps in (default: the
   * coordinator's `leaseMs` when it exposes one, else `'30s'`).
   */
  leaderTtlMs?: string | number
  /** Clock used for durable tasks (epoch ms). For tests; default `Date.now`. */
  now?: () => number
  /**
   * Default IANA zone (`'America/Bogota'`, `'Europe/Madrid'`, `'UTC'`, or `'local'`) the
   * cron fields of this scheduler's cron tasks are read in, plain and durable alike; a
   * task's own `timeZone` overrides it. Default: the process zone (today's behaviour).
   * Validated at construction (`RangeError` for an unknown zone). See
   * `CronTaskOptions.timeZone` for the daylight-saving rules.
   */
  timeZone?: string
}

const clone = (r: ScheduleRecord): ScheduleRecord => ({ ...r })

/** Reference, in-process {@link ScheduleStore}. Nothing survives the process. */
export class MemoryScheduleStore implements ScheduleStore {
  private readonly rows = new Map<string, ScheduleRecord>()
  /** Fencing token of deleted ids (high-water marks). */
  private readonly fences = new Map<string, number>()

  async get(id: string): Promise<ScheduleRecord | null> {
    const row = this.rows.get(id)
    return row ? clone(row) : null
  }

  async register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord> {
    const row = this.rows.get(rec.id)
    if (row) {
      if (row.kind !== rec.kind || row.spec !== rec.spec) {
        row.kind = rec.kind
        row.spec = rec.spec
        row.nextRunAt = rec.nextRunAt
        row.updatedAt = now
      }
      return clone(row)
    }
    const fencingToken = this.fences.get(rec.id) ?? 0
    const created: ScheduleRecord = { id: rec.id, kind: rec.kind, spec: rec.spec, nextRunAt: rec.nextRunAt, fencingToken, updatedAt: now }
    this.rows.set(rec.id, created)
    return clone(created)
  }

  async claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null> {
    const row = this.rows.get(id)
    if (!row || !isScheduleClaimable(row, now)) return null
    row.fencingToken += 1
    row.leaseOwner = owner
    row.leaseUntil = now + leaseMs
    row.updatedAt = now
    return { record: clone(row), fencingToken: row.fencingToken }
  }

  async renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.fencingToken !== fencingToken || row.leaseOwner === undefined) return false
    row.leaseUntil = leaseUntil
    return true
  }

  async complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.fencingToken !== fencingToken || row.leaseOwner === undefined) return false
    Object.assign(row, applyScheduleComplete(row, patch, now))
    delete row.leaseOwner
    delete row.leaseUntil
    return true
  }

  async delete(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return
    this.fences.set(id, Math.max(row.fencingToken, this.fences.get(id) ?? 0))
    this.rows.delete(id)
  }

  async list(): Promise<ScheduleRecord[]> {
    return [...this.rows.values()].map(clone)
  }
}

/** The claim condition of the contract, shared by the JS-side backends. */
export function isScheduleClaimable(row: ScheduleRecord, now: number): boolean {
  return row.nextRunAt !== null && row.nextRunAt <= now && (row.leaseUntil === undefined || row.leaseUntil <= now)
}

/** The record after a successful `complete` (lease cleared), shared by the JS-side backends. */
export function applyScheduleComplete(row: ScheduleRecord, patch: CompletePatch, now: number): ScheduleRecord {
  const next: ScheduleRecord = { ...row, nextRunAt: patch.nextRunAt, updatedAt: now }
  if (patch.lastRunAt !== undefined) next.lastRunAt = patch.lastRunAt
  if (patch.lastStatus !== undefined) next.lastStatus = patch.lastStatus
  delete next.leaseOwner
  delete next.leaseUntil
  return next
}

/**
 * Wrap `store` so every id is stored under `prefix` (and `list()` only returns, unprefixed,
 * the ids under it). The bot uses it with its store namespace, so bots sharing a backend
 * never collide.
 */
export function prefixScheduleStore(store: ScheduleStore, prefix: string): ScheduleStore {
  if (!prefix) return store
  const strip = (r: ScheduleRecord): ScheduleRecord => ({ ...r, id: r.id.slice(prefix.length) })
  return {
    start: store.start ? () => store.start!() : undefined,
    get: async (id) => {
      const r = await store.get(prefix + id)
      return r ? strip(r) : null
    },
    register: async (rec, now) => strip(await store.register({ ...rec, id: prefix + rec.id }, now)),
    claimDue: async (id, owner, now, leaseMs) => {
      const c = await store.claimDue(prefix + id, owner, now, leaseMs)
      return c ? { record: strip(c.record), fencingToken: c.fencingToken } : null
    },
    renew: (id, token, until) => store.renew(prefix + id, token, until),
    complete: (id, token, patch, now) => store.complete(prefix + id, token, patch, now),
    delete: (id) => store.delete(prefix + id),
    list: async () => (await store.list()).filter((r) => r.id.startsWith(prefix)).map(strip),
  }
}
