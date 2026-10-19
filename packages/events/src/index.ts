import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
}

export interface ClaimEventOptions {
  now?: number
  leaseMs?: number
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
  replay(eventId: string, now?: number): Promise<void>
  list(options?: { state?: EventRecordState; limit?: number }): Promise<EventRecord[]>
}

export class MemoryEventJournal implements EventJournal {
  private records = new Map<string, EventRecord>()
  private idempotency = new Map<string, string>()

  async append<TPayload>(envelope: EventEnvelope<TPayload>): Promise<boolean> {
    if (this.records.has(envelope.eventId) || this.idempotency.has(envelope.idempotencyKey)) return false
    const record: EventRecord<TPayload> = {
      envelope,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: envelope.occurredAt,
    }
    this.records.set(envelope.eventId, record as EventRecord)
    this.idempotency.set(envelope.idempotencyKey, envelope.eventId)
    return true
  }

  async get(eventId: string): Promise<EventRecord | undefined> {
    const record = this.records.get(eventId)
    return record ? structuredClone(record) : undefined
  }

  async claim(limit: number, options: ClaimEventOptions = {}): Promise<EventRecord[]> {
    const now = options.now ?? Date.now()
    const leaseMs = options.leaseMs ?? 30_000
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('claim limit must be a positive integer')
    const available = [...this.records.values()]
      .filter((record) =>
        (record.state === 'pending' || record.state === 'failed') && record.nextAttemptAt <= now ||
        record.state === 'processing' && (record.leaseUntil ?? 0) <= now)
      .sort((a, b) =>
        a.envelope.partitionKey.localeCompare(b.envelope.partitionKey) ||
        a.envelope.occurredAt - b.envelope.occurredAt)
      .slice(0, limit)
    for (const record of available) {
      record.state = 'processing'
      record.leaseUntil = now + leaseMs
      record.attempts++
      record.fencingToken = (record.fencingToken ?? 0) + 1
    }
    return structuredClone(available)
  }

  async ack(eventId: string, options: AckEventOptions = {}): Promise<void> {
    const record = this.fenced(eventId, options.fencingToken)
    const now = options.now ?? Date.now()
    record.state = 'done'
    record.completedAt = now
    record.leaseUntil = undefined
    record.lastError = undefined
  }

  async fail(eventId: string, error: unknown, options: FailEventOptions = {}): Promise<void> {
    const record = this.fenced(eventId, options.fencingToken)
    const maxAttempts = options.maxAttempts ?? 5
    const now = options.now ?? Date.now()
    record.lastError = error instanceof Error ? error.message : String(error)
    record.leaseUntil = undefined
    if (record.attempts >= maxAttempts) {
      record.state = 'dead'
      return
    }
    record.state = 'failed'
    record.nextAttemptAt = now + (options.retryDelayMs ?? exponentialBackoff(record.attempts))
  }

  async replay(eventId: string, now = Date.now()): Promise<void> {
    const record = this.required(eventId)
    record.state = 'pending'
    record.attempts = 0
    record.nextAttemptAt = now
    record.leaseUntil = undefined
    record.lastError = undefined
    record.completedAt = undefined
  }

  async list(options: { state?: EventRecordState; limit?: number } = {}): Promise<EventRecord[]> {
    const limit = options.limit ?? 100
    return structuredClone(
      [...this.records.values()]
        .filter((record) => !options.state || record.state === options.state)
        .sort((a, b) => a.envelope.occurredAt - b.envelope.occurredAt)
        .slice(0, limit),
    )
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
    if (!record) throw new Error(`Event ${eventId} does not exist`)
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

/** Durable single-process journal with atomic snapshot replacement. */
export class FileEventJournal implements EventJournal {
  private writeQueue: Promise<void> = Promise.resolve()
  private constructor(private readonly filePath: string, private readonly memory: MemoryEventJournal) {}
  static async open(filePath: string): Promise<FileEventJournal> {
    let records: EventRecord[] = []
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { version?: number; records?: EventRecord[] }
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('invalid event journal snapshot')
      records = parsed.records
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return new FileEventJournal(filePath, MemoryEventJournal.fromSnapshot(records))
  }
  async append<TPayload>(envelope: EventEnvelope<TPayload>): Promise<boolean> { const changed = await this.memory.append(envelope); if (changed) await this.persist(); return changed }
  get(eventId: string): Promise<EventRecord | undefined> { return this.memory.get(eventId) }
  async claim(limit: number, options?: ClaimEventOptions): Promise<EventRecord[]> { const records = await this.memory.claim(limit, options); if (records.length) await this.persist(); return records }
  async ack(eventId: string, options?: AckEventOptions): Promise<void> { await this.memory.ack(eventId, options); await this.persist() }
  async fail(eventId: string, error: unknown, options?: FailEventOptions): Promise<void> { await this.memory.fail(eventId, error, options); await this.persist() }
  async replay(eventId: string, now?: number): Promise<void> { await this.memory.replay(eventId, now); await this.persist() }
  list(options?: { state?: EventRecordState; limit?: number }): Promise<EventRecord[]> { return this.memory.list(options) }
  private persist(): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, records: this.memory.snapshot() }), 'utf8')
        await rename(temporary, this.filePath)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    })
    // The caller sees this write's failure; the queue does not, so one failed
    // write (full disk, a transient EPERM on Windows) never blocks later ones.
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
      // it; leave it to them instead.
      if (record.leaseUntil !== undefined && clock() >= record.leaseUntil) {
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
