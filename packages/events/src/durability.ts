/**
 * `@bot-wa/events/durability` — use an `@bot-wa/events` journal as the durability backend of a
 * bot (`BotConfig.durability.journal`), so an app that already keeps an {@link EventJournal}
 * gets durable message processing without another store.
 *
 * - **Inbox**: the bot's inbound records are stored as {@link EventRecord}s of the user's
 *   journal under an isolation channel (default `'botwa:durable'`), so the events tooling
 *   (`list`, `replay`, DLQ inspection) sees them, while an {@link EventWorker} never claims
 *   them. Leases and fencing tokens are the journal's own.
 * - **Outbox**: the core outbox state machine over a key-value store kept as a *sidecar* of
 *   the same journal (same file, same atomic snapshot), or over a `DurableKv` you pass.
 *
 * The bot (the core engine) processes its records itself: per-chat FIFO, causation and
 * ack-on-settle stay in the core. Requires `@bot-wa/core` (optional peer dependency).
 *
 * @example
 * ```ts
 * import { FileEventJournal } from '@bot-wa/events'
 * import { eventsDurability } from '@bot-wa/events/durability'
 *
 * const journal = await FileEventJournal.open('./data/events.json', { lock: true })
 * const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
 * ```
 */

import {
  KvOutbox, MemoryKv, StaleLeaseError,
  type ClaimOptions, type DurabilityBackend, type DurableKv, type InboxAppend, type InboxJournal, type InboxRecord,
  type InboxState, type JsonValue, type LeaseOptions, type MemoryKvSnapshot, type OutboxJournal,
} from '@bot-wa/core'
import {
  EventNotFoundError, FileEventJournal, StaleLeaseError as EventStaleLeaseError,
  type EventContext, type EventEnvelope, type EventRecord, type LeasedEventJournal, type SidecarHandle,
} from './index.js'

/** Options of {@link eventsDurability}. */
export interface EventsDurabilityOptions {
  /** The journal that stores the bot's inbound records (and, by default, its outbox). */
  journal: LeasedEventJournal
  /**
   * Outbox storage. Default: a key-value store kept as a sidecar of `journal` (requires
   * `journal.sidecar`, which the memory and file journals have). Pass a shared `DurableKv`
   * (e.g. a Postgres or Redis one) when the journal is shared by several processes.
   */
  outbox?: DurableKv
  /** Envelope context written on the bot's records. Default: `'botwa'` placeholders. */
  context?: Partial<EventContext>
  /** Isolation channel of the bot's records. Default `'botwa:durable'`. */
  channel?: string
  /**
   * Only one process uses this storage at a time (see `DurabilityBackend.exclusive`).
   * Default: `journal.exclusive` (true for the memory journal and a locked file journal).
   */
  exclusive?: boolean
}

/** The payload of a bot record in the events journal (an inbox record's own fields). */
export interface DurableInboundPayload {
  /** The inbox record id (unscoped). */
  id: string
  kind: 'message' | 'interaction'
  /** The journaled inbound event. */
  payload: JsonValue
  /** The inbound dedupe key + fingerprint the id was derived from (diagnostics). */
  idempotencyKey?: string
}

const OUTBOX_SIDECAR = 'botwa.outbox'
const DEFAULT_CHANNEL = 'botwa:durable'
const DEFAULT_CONTEXT: EventContext = { tenantId: 'botwa', environmentId: 'botwa', botId: 'botwa', providerId: 'botwa', connectionId: 'botwa' }

/** The outbox KV kept as a journal sidecar: every committed write rewrites the journal snapshot. */
class SidecarKv extends MemoryKv {
  handle: SidecarHandle | undefined
  protected override async changed(): Promise<void> { await this.handle?.changed() }
}

/** One sidecar KV per journal, shared by every adapter (bot) and scope over it. */
const sidecarKvs = new WeakMap<LeasedEventJournal, SidecarKv>()

function sidecarKv(journal: LeasedEventJournal): SidecarKv {
  let kv = sidecarKvs.get(journal)
  if (kv) return kv
  if (typeof journal.sidecar !== 'function') {
    throw new TypeError('eventsDurability(): the journal has no sidecar(); pass `outbox` (a DurableKv) for the outbox')
  }
  const created = new SidecarKv()
  created.handle = journal.sidecar(OUTBOX_SIDECAR, {
    snapshot: () => created.snapshot(),
    restore: (data) => created.restore(data as MemoryKvSnapshot),
  })
  sidecarKvs.set(journal, created)
  kv = created
  return kv
}

/** Run a fenced journal call, rethrowing the events errors as the core `StaleLeaseError` the engine expects. */
async function fenced<T>(id: string, token: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof EventStaleLeaseError) throw new StaleLeaseError(id, token, error.currentToken, error.state)
    if (error instanceof EventNotFoundError) throw new StaleLeaseError(id, token, -1, 'missing')
    throw error
  }
}

function byReceived(a: InboxRecord, b: InboxRecord): number {
  return a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** {@link InboxJournal} over a {@link LeasedEventJournal} (one scope of it). */
class EventsInbox implements InboxJournal {
  constructor(
    private readonly journal: LeasedEventJournal,
    private readonly channel: string,
    private readonly prefix: string,
    private readonly context: EventContext,
  ) {}

  private eventId(id: string): string { return this.prefix + id }
  private mine = (r: EventRecord): boolean => r.envelope.eventId.startsWith(this.prefix)

  private toInbox(r: EventRecord): InboxRecord {
    const p = r.envelope.payload as DurableInboundPayload
    return {
      id: p.id,
      ...(p.idempotencyKey !== undefined ? { idempotencyKey: p.idempotencyKey } : {}),
      partitionKey: r.envelope.partitionKey,
      kind: p.kind,
      payload: p.payload,
      state: r.state as InboxState,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      ...(r.leaseUntil !== undefined ? { leaseUntil: r.leaseUntil } : {}),
      ...(r.owner !== undefined ? { owner: r.owner } : {}),
      fencingToken: r.fencingToken ?? 0,
      receivedAt: r.envelope.occurredAt,
      ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
      ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
    }
  }

  private envelope(input: InboxAppend): EventEnvelope<DurableInboundPayload> {
    const eventId = this.eventId(input.id)
    return {
      eventId,
      eventType: `botwa.inbound.${input.kind}`,
      schemaVersion: 1,
      occurredAt: input.receivedAt,
      context: { ...this.context },
      correlationId: eventId,
      idempotencyKey: eventId,
      partitionKey: input.partitionKey,
      payload: {
        id: input.id,
        kind: input.kind,
        payload: input.payload,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      },
    }
  }

  async append(input: InboxAppend, now: number, lease?: LeaseOptions): Promise<{ status: 'appended' | 'duplicate'; record: InboxRecord }> {
    const out = await this.journal.appendRecord(this.envelope(input), { now, channel: this.channel, ...(lease ? { lease } : {}) })
    return { status: out.status, record: this.toInbox(out.record) }
  }

  async claim(o: ClaimOptions): Promise<InboxRecord[]> {
    const records = await this.journal.claim(o.limit, {
      now: o.now,
      leaseMs: o.leaseMs,
      owner: o.owner,
      reclaimOwn: o.reclaimOwn === true,
      channel: this.channel,
      order: 'occurredAt',
      filter: (r) => this.mine(r) && (!o.partitions || o.partitions(r.envelope.partitionKey)),
    })
    return records.map((r) => this.toInbox(r)).sort(byReceived)
  }

  async claimOne(id: string, o: LeaseOptions): Promise<InboxRecord | null> {
    const r = await this.journal.claimOne(this.eventId(id), o)
    return r ? this.toInbox(r) : null
  }

  ack(id: string, token: number, now: number): Promise<void> {
    return fenced(id, token, () => this.journal.ack(this.eventId(id), { now, fencingToken: token }))
  }

  fail(id: string, token: number, error: string, o: { now: number; retryAt?: number; dead?: boolean }): Promise<void> {
    return fenced(id, token, () => this.journal.fail(this.eventId(id), error, {
      now: o.now, fencingToken: token, dead: o.dead === true, retryAt: o.retryAt ?? o.now,
    }))
  }

  release(id: string, token: number, now: number): Promise<void> {
    return fenced(id, token, () => this.journal.release(this.eventId(id), { now, fencingToken: token, toPending: true }))
  }

  extend(id: string, token: number, leaseUntil: number): Promise<void> {
    return fenced(id, token, () => this.journal.extend(this.eventId(id), { fencingToken: token, leaseUntil }))
  }

  async replay(id: string, now: number): Promise<void> {
    try {
      await this.journal.replay(this.eventId(id), now)
    } catch (error) {
      if (!(error instanceof EventNotFoundError)) throw error
    }
  }

  async get(id: string): Promise<InboxRecord | undefined> {
    const r = await this.journal.get(this.eventId(id))
    return r && r.channel === this.channel ? this.toInbox(r) : undefined
  }

  async list(filter: { state?: InboxState; limit?: number } = {}): Promise<InboxRecord[]> {
    const records = await this.journal.list({
      ...(filter.state ? { state: filter.state } : {}),
      limit: Number.POSITIVE_INFINITY,
      channel: this.channel,
      filter: this.mine,
    })
    const out = records.map((r) => this.toInbox(r)).sort(byReceived)
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out
  }

  purge(o: { doneBefore: number; includeDead?: boolean }): Promise<number> {
    return this.journal.purge({ doneBefore: o.doneBefore, includeDead: o.includeDead === true, channel: this.channel, filter: this.mine })
  }
}

interface ResolvedOptions {
  journal: LeasedEventJournal
  kv: DurableKv
  context: EventContext
  channel: string
  exclusive: boolean
  /** Owns the kv's lifecycle (a caller-provided outbox KV). */
  ownsKv: boolean
}

/** A {@link DurabilityBackend} over an `@bot-wa/events` journal. Build it with {@link eventsDurability}. */
export class EventsDurability implements DurabilityBackend {
  readonly inbox: InboxJournal
  readonly outbox: OutboxJournal
  readonly exclusive: boolean
  /** The scope of this view (`undefined` = the unscoped records). */
  readonly scopeName: string | undefined
  /** The events journal holding the inbound records. */
  readonly journal: LeasedEventJournal

  /** @internal Use {@link eventsDurability}. */
  constructor(private readonly opts: ResolvedOptions, scope?: string) {
    this.journal = opts.journal
    this.exclusive = opts.exclusive
    this.scopeName = scope
    const prefix = `inbox:${scope === undefined ? '' : encodeURIComponent(scope)}:`
    this.inbox = new EventsInbox(opts.journal, opts.channel, prefix, opts.context)
    this.outbox = new KvOutbox(opts.kv, scope === undefined ? 'outbox' : `outbox:${scope}`)
  }

  /** A view over the same journal holding only the records of `name` (see `DurabilityBackend.scope`). */
  scope(name: string): EventsDurability {
    if (typeof name !== 'string' || name === '') throw new TypeError('EventsDurability.scope(): name must be a non-empty string')
    return new EventsDurability(this.opts, this.scopeName === undefined ? name : `${this.scopeName}:${name}`)
  }

  async start(): Promise<void> { if (this.opts.ownsKv) await this.opts.kv.start?.() }
  /** The user's journal is never closed here (close a file journal yourself after `bot.stop()`). */
  async stop(): Promise<void> { if (this.opts.ownsKv) await this.opts.kv.stop?.() }
}

/**
 * Build a durability backend over an `@bot-wa/events` journal (see the module docs).
 * @throws {TypeError} when the journal lacks the leased operations, has no sidecar and no
 *   `outbox` was given, or is a `FileEventJournal` opened without `{ lock: true }`.
 */
export function eventsDurability(options: EventsDurabilityOptions): EventsDurability {
  const journal = options?.journal
  if (!journal || typeof journal !== 'object') throw new TypeError('eventsDurability(): `journal` is required')
  for (const method of ['appendRecord', 'claim', 'claimOne', 'extend', 'ack', 'fail', 'release', 'replay', 'get', 'list', 'purge'] as const) {
    if (typeof (journal as unknown as Record<string, unknown>)[method] !== 'function') {
      throw new TypeError(`eventsDurability(): the journal has no ${method}() (a LeasedEventJournal is required)`)
    }
  }
  if (journal instanceof FileEventJournal && !journal.locked) {
    throw new TypeError('eventsDurability(): open the FileEventJournal with { lock: true } so a second process cannot use it at the same time')
  }
  const channel = options.channel ?? DEFAULT_CHANNEL
  if (typeof channel !== 'string' || channel === '') throw new TypeError('eventsDurability(): `channel` must be a non-empty string')
  const kv = options.outbox ?? sidecarKv(journal)
  return new EventsDurability({
    journal,
    kv,
    context: { ...DEFAULT_CONTEXT, ...options.context },
    channel,
    exclusive: options.exclusive ?? journal.exclusive === true,
    ownsKv: options.outbox !== undefined,
  })
}
