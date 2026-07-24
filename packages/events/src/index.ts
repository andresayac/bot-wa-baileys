import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
  lastError?: string
  completedAt?: number
}

export interface FailEventOptions {
  maxAttempts?: number
  retryDelayMs?: number
  now?: number
}

/**
 * Persistence boundary. SQL/Redis adapters can implement this contract without
 * changing workers or the control plane.
 */
export interface EventJournal {
  append<TPayload>(envelope: EventEnvelope<TPayload>): Promise<boolean>
  get(eventId: string): Promise<EventRecord | undefined>
  claim(limit: number, options?: { now?: number; leaseMs?: number }): Promise<EventRecord[]>
  ack(eventId: string, now?: number): Promise<void>
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

  async claim(limit: number, options: { now?: number; leaseMs?: number } = {}): Promise<EventRecord[]> {
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
    }
    return structuredClone(available)
  }

  async ack(eventId: string, now = Date.now()): Promise<void> {
    const record = this.required(eventId)
    record.state = 'done'
    record.completedAt = now
    record.leaseUntil = undefined
    record.lastError = undefined
  }

  async fail(eventId: string, error: unknown, options: FailEventOptions = {}): Promise<void> {
    const record = this.required(eventId)
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
  async claim(limit: number, options?: { now?: number; leaseMs?: number }): Promise<EventRecord[]> { const records = await this.memory.claim(limit, options); if (records.length) await this.persist(); return records }
  async ack(eventId: string, now?: number): Promise<void> { await this.memory.ack(eventId, now); await this.persist() }
  async fail(eventId: string, error: unknown, options?: FailEventOptions): Promise<void> { await this.memory.fail(eventId, error, options); await this.persist() }
  async replay(eventId: string, now?: number): Promise<void> { await this.memory.replay(eventId, now); await this.persist() }
  list(options?: { state?: EventRecordState; limit?: number }): Promise<EventRecord[]> { return this.memory.list(options) }
  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify({ version: 1, records: this.memory.snapshot() }), 'utf8')
      await rename(temporary, this.filePath)
    })
    return this.writeQueue
  }
}

export type EventHandler<TPayload = unknown> = (envelope: EventEnvelope<TPayload>) => void | Promise<void>

export class EventWorker {
  private handlers = new Map<string, EventHandler>()

  constructor(
    private readonly journal: EventJournal,
    private readonly options: { maxAttempts?: number; retryDelayMs?: number } = {},
  ) {}

  on<TPayload>(eventType: string, handler: EventHandler<TPayload>): () => void {
    if (this.handlers.has(eventType)) throw new Error(`Handler already registered for ${eventType}`)
    this.handlers.set(eventType, handler as EventHandler)
    return () => this.handlers.delete(eventType)
  }

  async runBatch(limit = 100): Promise<{ processed: number; failed: number }> {
    const records = await this.journal.claim(limit)
    let processed = 0
    let failed = 0
    for (const record of records) {
      const handler = this.handlers.get(record.envelope.eventType)
      try {
        if (!handler) throw new Error(`No handler registered for ${record.envelope.eventType}`)
        await handler(record.envelope)
        await this.journal.ack(record.envelope.eventId)
        processed++
      } catch (error) {
        await this.journal.fail(record.envelope.eventId, error, this.options)
        failed++
      }
    }
    return { processed, failed }
  }
}

export function exponentialBackoff(attempt: number, baseMs = 1_000, capMs = 60_000): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(capMs, baseMs * 2 ** (safeAttempt - 1))
}
