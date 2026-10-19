import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface EventContext {
  tenantId: string
  environmentId: string
  botId: string
  providerId: string
  connectionId: string
  chatId?: string
  participantId?: string
}

export interface EventEnvelope<TPayload = unknown> {
  eventId: string
  eventType: string
  schemaVersion: number
  occurredAt: number
  context: EventContext
  correlationId: string
  causationId?: string
  idempotencyKey: string
  partitionKey: string
  payload: TPayload
}

export interface CreateEnvelopeInput<TPayload> {
  eventId?: string
  eventType: string
  schemaVersion?: number
  occurredAt?: number
  context: EventContext
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
  partitionKey?: string
  payload: TPayload
}

export function createEnvelope<TPayload>(input: CreateEnvelopeInput<TPayload>): EventEnvelope<TPayload> {
  if (!input.eventType.trim()) throw new Error('eventType is required')
  if (!Number.isInteger(input.schemaVersion ?? 1) || (input.schemaVersion ?? 1) <= 0) {
    throw new Error('schemaVersion must be a positive integer')
  }
  for (const [field, value] of Object.entries(input.context)) {
    if (field.endsWith('Id') && typeof value === 'string' && value.trim() === '') {
      throw new Error(`context.${field} must not be empty`)
    }
  }

  const eventId = input.eventId ?? randomUUID()
  const correlationId = input.correlationId ?? eventId
  const partitionKey = input.partitionKey ??
    [
      input.context.tenantId,
      input.context.botId,
      input.context.connectionId,
      input.context.chatId ?? 'global',
    ].join('/')

  return {
    eventId,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? 1,
    occurredAt: input.occurredAt ?? Date.now(),
    context: { ...input.context },
    correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey ?? eventId,
    partitionKey,
    payload: input.payload,
  }
}

export type EventRecordState = 'pending' | 'processing' | 'failed' | 'done' | 'dead'

export interface EventRecord<TPayload = unknown> {
  envelope: EventEnvelope<TPayload>
  state: EventRecordState
  attempts: number
  nextAttemptAt: number
  leaseUntil?: number
  /**
   * Fencing token of the latest claim. Strictly increasing per event (never
   * reused, not even after `replay`); 0 or absent if it was never claimed.
   * Pass it back to `ack`/`fail` so a worker whose lease expired cannot
   * complete an event another worker has since re-claimed.
   */
  fencingToken?: number
  lastError?: string
  completedAt?: number
  /** Holder of the current lease (claims made with `owner`). */
  owner?: string
  /**
   * Isolation channel. Records appended with a channel (e.g. the bot's durable inbox, see
   * `@bot-wa/events/durability`) are only claimed or purged by callers naming that channel,
   * so an {@link EventWorker} never runs them. `list()` still shows every record.
   */
  channel?: string
}

export interface ClaimEventOptions {
  now?: number
  leaseMs?: number
  /** Lease holder recorded on each claimed record. */
  owner?: string
  /** Also take `owner`'s own unexpired leases (a restarted process with a stable owner id). */
  reclaimOwn?: boolean
  /** Only records of this channel. Omitted: only records without a channel (today's behaviour). */
  channel?: string
  /** Only records passing this predicate. */
  filter?: (record: EventRecord) => boolean
  /** `'partition'` (default): by partition key, then age. `'occurredAt'`: oldest first across partitions. */
  order?: 'partition' | 'occurredAt'
}

export interface AckEventOptions {
  now?: number
  /**
   * Token from the claim being acknowledged. When set, the call is rejected
   * with {@link StaleLeaseError} unless the event is still `processing` under
   * this same token. Omit it only for operator overrides.
   */
  fencingToken?: number
}

export interface FailEventOptions extends AckEventOptions {
  maxAttempts?: number
  retryDelayMs?: number
  /**
   * Explicit outcome (instead of `maxAttempts`/`retryDelayMs`): `true` dead-letters the event
   * now (and records `completedAt`); otherwise it is retried at {@link retryAt}.
   */
  dead?: boolean
  /** Explicit retry time (epoch ms); default `now`. Setting it (or `dead`) skips the attempt count. */
  retryAt?: number
}

export interface ReleaseEventOptions extends AckEventOptions {
  /** Always back to `pending`, due `now` (default: `failed` if it failed before, never later than it was due). */
  toPending?: boolean
}

/** Lease parameters of {@link LeasedEventJournal.claimOne} / {@link AppendEventOptions.lease}. */
export interface EventLease {
  now: number
  leaseMs: number
  owner: string
}

/** Options of {@link LeasedEventJournal.appendRecord}. */
export interface AppendEventOptions {
  /** When the new record becomes due. Default: the envelope's `occurredAt`. */
  now?: number
  /** Isolation channel of the record (see {@link EventRecord.channel}). */
  channel?: string
  /** Create the record already claimed (`processing`, token 1, 1 attempt) under this lease. */
  lease?: EventLease
}

/** Options of {@link LeasedEventJournal.list}. */
export interface ListEventOptions {
  state?: EventRecordState
  /** Default 100; `Infinity` for every record. */
  limit?: number
  /** Only records of this channel. Omitted: every record. */
  channel?: string
  filter?: (record: EventRecord) => boolean
}

/** Options of {@link LeasedEventJournal.purge}. */
export interface PurgeEventOptions {
  /** Delete `done` records completed before this time (epoch ms). */
  doneBefore: number
  /** Also delete `dead` records completed before `doneBefore`. */
  includeDead?: boolean
  /** Only records of this channel. Omitted: only records without a channel. */
  channel?: string
  filter?: (record: EventRecord) => boolean
}

/** Side state stored with the journal's records, in the same atomic snapshot (see {@link LeasedEventJournal.sidecar}). */
export interface JournalSidecar {
  snapshot(): unknown
  restore(data: unknown): void
}

/** Returned by {@link LeasedEventJournal.sidecar}: call `changed()` after every write of the side state. */
export interface SidecarHandle {
  changed(): Promise<void>
}

/** The event does not exist (fenced operations, `replay`). */
export class EventNotFoundError extends Error {
  constructor(readonly eventId: string) {
    super(`Event ${eventId} does not exist`)
    this.name = 'EventNotFoundError'
  }
}

/**
 * Raised by a fenced `ack`/`fail` whose claim was superseded: the lease
 * expired and another worker re-claimed the event, or the event already left
 * `processing` (acknowledged, failed or replayed).
 */
export class StaleLeaseError extends Error {
  constructor(
    readonly eventId: string,
    readonly fencingToken: number,
    readonly currentToken: number,
    readonly state: EventRecordState,
  ) {
    super(`Stale lease for event ${eventId}: token ${fencingToken} (current ${currentToken}, state ${state})`)
    this.name = 'StaleLeaseError'
  }
}

/**
 * Persistence boundary. SQL/Redis adapters can implement this contract without
 * changing workers or the control plane.
 */
export interface EventJournal {
  append<TPayload>(envelope: EventEnvelope<TPayload>): Promise<boolean>
  get(eventId: string): Promise<EventRecord | undefined>
  /** Lease up to `limit` due events; each returned record carries a fresh `fencingToken`. */
  claim(limit: number, options?: ClaimEventOptions): Promise<EventRecord[]>
  /** Mark done. With `fencingToken`, rejects with {@link StaleLeaseError} if the claim was superseded. */
  ack(eventId: string, options?: AckEventOptions): Promise<void>
  /** Schedule a retry or dead-letter the event. Fenced like `ack`. */
  fail(eventId: string, error: unknown, options?: FailEventOptions): Promise<void>
  /**
   * Hand back a claim whose handler never ran: the event becomes due again
   * right away and the claim's attempt is not charged. Fenced like `ack`.
   */
  release(eventId: string, options?: AckEventOptions): Promise<void>
  replay(eventId: string, now?: number): Promise<void>
  list(options?: { state?: EventRecordState; limit?: number }): Promise<EventRecord[]>
}

/**
 * An {@link EventJournal} with the atomic, fenced operations a durability backend needs
 * (`@bot-wa/events/durability`): channel isolation, owner-aware claims, single-record claims,
 * lease extension, purge and side state persisted with the records. Every operation is
 * atomic: two claimers can never get the same record, and a completion is accepted only
 * under the fencing token of the current claim.
 */
export interface LeasedEventJournal extends EventJournal {
  /** Only one process uses this journal at a time (memory; a locked file). */
  readonly exclusive?: boolean
  /**
   * Insert-if-absent by `eventId` or `idempotencyKey`; on conflict the existing record is
   * returned unchanged (`'duplicate'`).
   */
  appendRecord<TPayload>(envelope: EventEnvelope<TPayload>, options?: AppendEventOptions): Promise<{ status: 'appended' | 'duplicate'; record: EventRecord }>
  /** Lease one record when it is claimable (as `claim`); `null` otherwise. */
  claimOne(eventId: string, lease: EventLease): Promise<EventRecord | null>
  /** Extend the current lease (heartbeat). Rejects with {@link StaleLeaseError} unless `fencingToken` is the current claim. */
  extend(eventId: string, options: { fencingToken: number; leaseUntil: number }): Promise<void>
  /** Delete old terminal records; returns the count. */
  purge(options: PurgeEventOptions): Promise<number>
  release(eventId: string, options?: ReleaseEventOptions): Promise<void>
  list(options?: ListEventOptions): Promise<EventRecord[]>
  /**
   * Register side state persisted atomically with the records (same snapshot). Its saved
   * data, if any, is restored before this returns. A name is registered once per journal.
   */
  sidecar?(name: string, state: JournalSidecar): SidecarHandle
}

function claimable(record: EventRecord, now: number, owner: string | undefined, reclaimOwn: boolean): boolean {
  if (record.state === 'pending' || record.state === 'failed') return record.nextAttemptAt <= now
  if (record.state === 'processing') {
    return (record.leaseUntil ?? 0) <= now || (reclaimOwn && owner !== undefined && record.owner === owner)
  }
  return false
}

function lease(record: EventRecord, now: number, leaseMs: number, owner: string | undefined): void {
  record.state = 'processing'
  record.leaseUntil = now + leaseMs
  record.attempts++
  record.fencingToken = (record.fencingToken ?? 0) + 1
  if (owner !== undefined) record.owner = owner
  else delete record.owner
}

export class MemoryEventJournal implements LeasedEventJournal {
  /** A memory journal is only ever used by the process that holds it. */
  readonly exclusive = true
  private records = new Map<string, EventRecord>()
  private idempotency = new Map<string, string>()
  private sidecars = new Set<string>()

  async append<TPayload>(envelope: EventEnvelope<TPayload>): Promise<boolean> {
    return (await this.appendRecord(envelope)).status === 'appended'
  }

  async appendRecord<TPayload>(envelope: EventEnvelope<TPayload>, options: AppendEventOptions = {}): Promise<{ status: 'appended' | 'duplicate'; record: EventRecord }> {
    const existing = this.records.get(envelope.eventId) ?? this.records.get(this.idempotency.get(envelope.idempotencyKey) ?? '')
    if (existing) return { status: 'duplicate', record: structuredClone(existing) }
    const record: EventRecord<TPayload> = {
      envelope,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: options.now ?? envelope.occurredAt,
      ...(options.channel !== undefined ? { channel: options.channel } : {}),
    }
    if (options.lease) lease(record as EventRecord, options.lease.now, options.lease.leaseMs, options.lease.owner)
    this.records.set(envelope.eventId, record as EventRecord)
    this.idempotency.set(envelope.idempotencyKey, envelope.eventId)
    return { status: 'appended', record: structuredClone(record as EventRecord) }
  }

  async get(eventId: string): Promise<EventRecord | undefined> {
    const record = this.records.get(eventId)
    return record ? structuredClone(record) : undefined
  }

  async claim(limit: number, options: ClaimEventOptions = {}): Promise<EventRecord[]> {
    const now = options.now ?? Date.now()
    const leaseMs = options.leaseMs ?? 30_000
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('claim limit must be a positive integer')
    const byAge = options.order === 'occurredAt'
    const available = [...this.records.values()]
      .filter((record) =>
        record.channel === options.channel &&
        claimable(record, now, options.owner, options.reclaimOwn === true) &&
        (!options.filter || options.filter(structuredClone(record))))
      .sort((a, b) => byAge
        ? a.envelope.occurredAt - b.envelope.occurredAt || (a.envelope.eventId < b.envelope.eventId ? -1 : a.envelope.eventId > b.envelope.eventId ? 1 : 0)
        : a.envelope.partitionKey.localeCompare(b.envelope.partitionKey) || a.envelope.occurredAt - b.envelope.occurredAt)
      .slice(0, limit)
    for (const record of available) lease(record, now, leaseMs, options.owner)
    return structuredClone(available)
  }

  async claimOne(eventId: string, options: EventLease): Promise<EventRecord | null> {
    const record = this.records.get(eventId)
    if (!record || !claimable(record, options.now, options.owner, false)) return null
    lease(record, options.now, options.leaseMs, options.owner)
    return structuredClone(record)
  }

  async extend(eventId: string, options: { fencingToken: number; leaseUntil: number }): Promise<void> {
    this.fenced(eventId, options.fencingToken).leaseUntil = options.leaseUntil
  }

  async ack(eventId: string, options: AckEventOptions = {}): Promise<void> {
    const record = this.fenced(eventId, options.fencingToken)
    const now = options.now ?? Date.now()
    record.state = 'done'
    record.completedAt = now
    record.leaseUntil = undefined
    record.lastError = undefined
    delete record.owner
  }

  async fail(eventId: string, error: unknown, options: FailEventOptions = {}): Promise<void> {
    const record = this.fenced(eventId, options.fencingToken)
    const maxAttempts = options.maxAttempts ?? 5
    const now = options.now ?? Date.now()
    record.lastError = error instanceof Error ? error.message : String(error)
    record.leaseUntil = undefined
    delete record.owner
    if (options.dead !== undefined || options.retryAt !== undefined) {
      if (options.dead) {
        record.state = 'dead'
        record.completedAt = now
      } else {
        record.state = 'failed'
        record.nextAttemptAt = options.retryAt ?? now
      }
      return
    }
    if (record.attempts >= maxAttempts) {
      record.state = 'dead'
      return
    }
    record.state = 'failed'
    record.nextAttemptAt = now + (options.retryDelayMs ?? exponentialBackoff(record.attempts))
  }

  async release(eventId: string, options: ReleaseEventOptions = {}): Promise<void> {
    const record = this.fenced(eventId, options.fencingToken)
    if (record.state !== 'processing') return
    const now = options.now ?? Date.now()
    record.state = options.toPending || record.lastError === undefined ? 'pending' : 'failed'
    record.attempts = Math.max(0, record.attempts - 1)
    record.leaseUntil = undefined
    record.nextAttemptAt = options.toPending ? now : Math.min(record.nextAttemptAt, now)
    delete record.owner
  }

  async replay(eventId: string, now = Date.now()): Promise<void> {
    const record = this.required(eventId)
    record.state = 'pending'
    record.attempts = 0
    record.nextAttemptAt = now
    record.leaseUntil = undefined
    record.lastError = undefined
    record.completedAt = undefined
    delete record.owner
  }

  async list(options: ListEventOptions = {}): Promise<EventRecord[]> {
    const limit = options.limit ?? 100
    return structuredClone(
      [...this.records.values()]
        .filter((record) => !options.state || record.state === options.state)
        .filter((record) => options.channel === undefined || record.channel === options.channel)
        .filter((record) => !options.filter || options.filter(structuredClone(record)))
        .sort((a, b) => a.envelope.occurredAt - b.envelope.occurredAt)
        .slice(0, limit),
    )
  }

  async purge(options: PurgeEventOptions): Promise<number> {
    let n = 0
    for (const [eventId, record] of this.records) {
      if (record.channel !== options.channel) continue
      const terminal = record.state === 'done' || (options.includeDead === true && record.state === 'dead')
      if (!terminal || record.completedAt === undefined || record.completedAt >= options.doneBefore) continue
      if (options.filter && !options.filter(structuredClone(record))) continue
      this.records.delete(eventId)
      if (this.idempotency.get(record.envelope.idempotencyKey) === eventId) this.idempotency.delete(record.envelope.idempotencyKey)
      n++
    }
    return n
  }

  sidecar(name: string, _state: JournalSidecar): SidecarHandle {
    if (this.sidecars.has(name)) throw new Error(`sidecar ${name} is already registered on this journal`)
    this.sidecars.add(name)
    return { changed: async () => {} }
  }

  /** The record, after checking that `token` (when given) still owns its lease. */
  private fenced(eventId: string, token: number | undefined): EventRecord {
    const record = this.required(eventId)
    if (token === undefined) return record
    const current = record.fencingToken ?? 0
    if (record.state !== 'processing' || current !== token) {
      throw new StaleLeaseError(eventId, token, current, record.state)
    }
    return record
  }

  private required(eventId: string): EventRecord {
    const record = this.records.get(eventId)
    if (!record) throw new EventNotFoundError(eventId)
    return record
  }

  snapshot(): EventRecord[] { return structuredClone([...this.records.values()]) }
  static fromSnapshot(records: EventRecord[]): MemoryEventJournal {
    const journal = new MemoryEventJournal()
    for (const record of records) {
      journal.records.set(record.envelope.eventId, structuredClone(record))
      journal.idempotency.set(record.envelope.idempotencyKey, record.envelope.eventId)
    }
    return journal
  }
}

/** Options of {@link FileEventJournal.open}. */
export interface FileEventJournalOptions {
  /**
   * Take a `<file>.lock` advisory lock holding this process's pid, so a second process cannot
   * open the same journal while this one is alive (a lock left by a dead process is taken
   * over; nothing is ever killed). Within one process, a second locked `open()` of the same
   * file is refused until the first journal is closed. Required by
   * `@bot-wa/events/durability`. Default `false`.
   */
  lock?: boolean
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0) // signal 0: existence probe only, sends nothing
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Lock files held by an open journal of THIS process (canonical paths). */
const heldLocks = new Set<string>()

/** A canonical key for a lock path: real directory (symlinks resolved), case-folded on Windows. */
async function lockKey(lockPath: string): Promise<string> {
  const key = join(await realpath(dirname(lockPath)), basename(lockPath))
  return process.platform === 'win32' ? key.toLowerCase() : key
}

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(String(process.pid), 'utf8')
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
      // Our own pid while no journal of this process holds it (open() checks heldLocks):
      // a lock left by an earlier process that had the same pid (a restarted container).
      if (holder === process.pid) return
      if (pidAlive(holder)) throw new Error(`event journal is locked by live process ${holder}: ${lockPath}`)
      await rm(lockPath, { force: true }) // stale lock of a dead process
    }
  }
  throw new Error(`could not acquire event journal lock: ${lockPath}`)
}

/**
 * Durable single-process journal with atomic snapshot replacement. Every write rewrites the
 * whole snapshot (temp file + rename): a crash leaves the previous or the next one. Side state
 * registered with {@link sidecar} is part of the same snapshot (format version 2; version 1
 * is still written while no side state exists, and both open).
 */
export class FileEventJournal implements LeasedEventJournal {
  private writeQueue: Promise<void> = Promise.resolve()
  /** A write queued but not started yet: later changes join it (its snapshot is taken when it starts). */
  private queuedWrite: Promise<void> | undefined
  /** In-memory changes not written yet (lease extensions). */
  private dirty = false
  private closed = false
  private readonly registered = new Map<string, JournalSidecar>()
  private constructor(
    private readonly filePath: string,
    private readonly memory: MemoryEventJournal,
    private readonly lockPath: string | undefined,
    /** Key of this journal's entry in the in-process lock registry. */
    private readonly lockKey: string | undefined,
    /** Saved side state, including names this process never registers (kept on rewrite). */
    private readonly savedSidecars: Record<string, unknown>,
  ) {}

  /** The file is held under the advisory lock (`open(path, { lock: true })`) and the journal is not closed. */
  get locked(): boolean { return this.lockPath !== undefined && !this.closed }
  /** Only one process can use a locked file journal. */
  get exclusive(): boolean { return this.locked }

  /**
   * @throws {Error} when the file is not a valid journal, or (with `lock`) another live process
   *   holds it or another open journal of this process does.
   */
  static async open(filePath: string, options: FileEventJournalOptions = {}): Promise<FileEventJournal> {
    const lockPath = options.lock === true ? `${filePath}.lock` : undefined
    let key: string | undefined
    if (lockPath) {
      await mkdir(dirname(filePath), { recursive: true })
      key = await lockKey(lockPath)
      // Checked and claimed with no await in between, so two concurrent opens cannot both pass.
      if (heldLocks.has(key)) throw new Error(`event journal is already open in this process: ${filePath}`)
      heldLocks.add(key)
      try {
        await acquireLock(lockPath)
      } catch (error) {
        heldLocks.delete(key)
        throw error
      }
    }
    let records: EventRecord[] = []
    let sidecars: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { version?: number; records?: EventRecord[]; sidecars?: unknown }
      const okSidecars = parsed.version === 1 || (typeof parsed.sidecars === 'object' && parsed.sidecars !== null && !Array.isArray(parsed.sidecars))
      if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.records) || !okSidecars) {
        throw new Error('invalid event journal snapshot')
      }
      records = parsed.records
      if (parsed.version === 2) sidecars = parsed.sidecars as Record<string, unknown>
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (lockPath) await rm(lockPath, { force: true }).catch(() => {})
        if (key) heldLocks.delete(key)
        throw error
      }
    }
    return new FileEventJournal(filePath, MemoryEventJournal.fromSnapshot(records), lockPath, key, sidecars)
  }
  async append<TPayload>(envelope: EventEnvelope<TPayload>): Promise<boolean> { const changed = await this.memory.append(envelope); if (changed) await this.persist(); return changed }
  async appendRecord<TPayload>(envelope: EventEnvelope<TPayload>, options?: AppendEventOptions): Promise<{ status: 'appended' | 'duplicate'; record: EventRecord }> {
    const result = await this.memory.appendRecord(envelope, options)
    if (result.status === 'appended') await this.persist()
    return result
  }
  get(eventId: string): Promise<EventRecord | undefined> { return this.memory.get(eventId) }
  async claim(limit: number, options?: ClaimEventOptions): Promise<EventRecord[]> { const records = await this.memory.claim(limit, options); if (records.length) await this.persist(); return records }
  async claimOne(eventId: string, lease: EventLease): Promise<EventRecord | null> { const record = await this.memory.claimOne(eventId, lease); if (record) await this.persist(); return record }
  /**
   * Extends the lease in memory only; the file gets it with the next write (or `close()`).
   * A lease matters only while this process lives, so a heartbeat never rewrites the file.
   */
  async extend(eventId: string, options: { fencingToken: number; leaseUntil: number }): Promise<void> {
    this.assertOpen()
    await this.memory.extend(eventId, options)
    this.dirty = true
  }
  async ack(eventId: string, options?: AckEventOptions): Promise<void> { await this.memory.ack(eventId, options); await this.persist() }
  async fail(eventId: string, error: unknown, options?: FailEventOptions): Promise<void> { await this.memory.fail(eventId, error, options); await this.persist() }
  async release(eventId: string, options?: ReleaseEventOptions): Promise<void> { await this.memory.release(eventId, options); await this.persist() }
  async replay(eventId: string, now?: number): Promise<void> { await this.memory.replay(eventId, now); await this.persist() }
  list(options?: ListEventOptions): Promise<EventRecord[]> { return this.memory.list(options) }
  async purge(options: PurgeEventOptions): Promise<number> { const n = await this.memory.purge(options); if (n > 0) await this.persist(); return n }

  sidecar(name: string, state: JournalSidecar): SidecarHandle {
    if (this.registered.has(name)) throw new Error(`sidecar ${name} is already registered on this journal`)
    if (Object.prototype.hasOwnProperty.call(this.savedSidecars, name)) state.restore(this.savedSidecars[name])
    this.registered.set(name, state)
    return { changed: () => this.persist() }
  }

  /**
   * Write pending in-memory changes, wait for pending writes and release the lock (if any).
   * Idempotent. Later writes reject: a closed journal never writes without its lock.
   */
  async close(): Promise<void> {
    if (this.closed) return
    if (this.dirty) await this.persist().catch(() => {})
    this.closed = true
    await this.writeQueue
    if (this.lockPath) await rm(this.lockPath, { force: true })
    if (this.lockKey) heldLocks.delete(this.lockKey)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`event journal is closed: ${this.filePath}`)
  }

  private snapshotJson(): string {
    const records = this.memory.snapshot()
    if (this.registered.size === 0 && Object.keys(this.savedSidecars).length === 0) return JSON.stringify({ version: 1, records })
    const sidecars: Record<string, unknown> = { ...this.savedSidecars }
    for (const [name, state] of this.registered) sidecars[name] = state.snapshot()
    return JSON.stringify({ version: 2, records, sidecars })
  }

  /**
   * Rewrite the snapshot. A call made while another write is queued (not started) joins it:
   * that write takes its snapshot when it starts, so it carries this change too.
   */
  private persist(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`event journal is closed: ${this.filePath}`))
    if (this.queuedWrite) return this.queuedWrite
    const write: Promise<void> = this.writeQueue.then(async () => {
      if (this.queuedWrite === write) this.queuedWrite = undefined
      this.dirty = false
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, this.snapshotJson(), 'utf8')
        await rename(temporary, this.filePath)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    })
    // The caller sees this write's failure; the queue does not, so one failed
    // write (full disk, a transient EPERM on Windows) never blocks later ones.
    this.queuedWrite = write
    this.writeQueue = write.catch(() => {})
    return write
  }
}

export type EventHandler<TPayload = unknown> = (envelope: EventEnvelope<TPayload>) => void | Promise<void>

export interface EventWorkerOptions {
  /** Attempts before an event goes to the dead-letter state. Defaults to 5. */
  maxAttempts?: number
  /** Fixed retry delay; defaults to {@link exponentialBackoff}. */
  retryDelayMs?: number
  /** Lease length requested on each claim. Defaults to the journal default (30 s in the bundled journals). */
  leaseMs?: number
  /** Time source for claims, lease checks, acks and failures. Defaults to `Date.now`. */
  clock?: () => number
}

export interface EventBatchResult {
  /** Handled and acknowledged. */
  processed: number
  /** Handler threw (or none was registered); scheduled for retry or dead-lettered. */
  failed: number
  /**
   * Lease lost: it expired before the handler started (the handler was
   * skipped), or the journal fenced off the ack/fail because another worker
   * re-claimed the event.
   */
  stale: number
}

export class EventWorker {
  private handlers = new Map<string, EventHandler>()

  constructor(
    private readonly journal: EventJournal,
    private readonly options: EventWorkerOptions = {},
  ) {}

  on<TPayload>(eventType: string, handler: EventHandler<TPayload>): () => void {
    if (this.handlers.has(eventType)) throw new Error(`Handler already registered for ${eventType}`)
    this.handlers.set(eventType, handler as EventHandler)
    // Only remove THIS handler: a stale unsubscribe must not drop a later one.
    return () => {
      if (this.handlers.get(eventType) === handler) this.handlers.delete(eventType)
    }
  }

  async runBatch(limit = 100): Promise<EventBatchResult> {
    const clock = this.options.clock ?? Date.now
    const { maxAttempts, retryDelayMs, leaseMs } = this.options
    const records = await this.journal.claim(limit, { now: clock(), ...(leaseMs !== undefined ? { leaseMs } : {}) })
    const result: EventBatchResult = { processed: 0, failed: 0, stale: 0 }
    for (const record of records) {
      const { eventId, eventType } = record.envelope
      const fencingToken = record.fencingToken
      // Records run one after another, so a later lease can run out while
      // earlier handlers work. Running it then would race whoever re-claims
      // it; hand it back instead, so the skip does not use up an attempt.
      if (record.leaseUntil !== undefined && clock() >= record.leaseUntil) {
        try {
          await this.journal.release(eventId, { now: clock(), fencingToken })
        } catch (error) {
          // Already re-claimed by another worker: nothing to hand back.
          if (!(error instanceof StaleLeaseError)) throw error
        }
        result.stale++
        continue
      }
      const handler = this.handlers.get(eventType)
      let handlerError: unknown
      let ok = false
      try {
        if (!handler) throw new Error(`No handler registered for ${eventType}`)
        await handler(record.envelope)
        ok = true
      } catch (error) {
        handlerError = error
      }
      try {
        if (ok) {
          await this.journal.ack(eventId, { now: clock(), fencingToken })
          result.processed++
        } else {
          await this.journal.fail(eventId, handlerError, {
            now: clock(),
            fencingToken,
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
            ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
          })
          result.failed++
        }
      } catch (error) {
        // Fenced off: another worker owns the event now. Any other journal
        // error propagates; the remaining leases expire and get re-claimed.
        if (!(error instanceof StaleLeaseError)) throw error
        result.stale++
      }
    }
    return result
  }
}

export function exponentialBackoff(attempt: number, baseMs = 1_000, capMs = 60_000): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(capMs, baseMs * 2 ** (safeAttempt - 1))
}
