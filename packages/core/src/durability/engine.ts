/**
 * DurableEngine (internal) — drives the inbox/outbox journals for one Bot.
 *
 * Inbound (live): append (already claimed) → run the normal pipeline under the record's
 * causation context → wait until the conversation steps it started/fed settled → ack.
 * Records of one partition (chat) are processed in order, and records recovered at
 * start-up are queued before any live message of their chat.
 *
 * Outbound: every send gets an idempotency key (explicit, `${inboundId}:${n}` from the
 * causation context, or random). A key already `sent` returns the recorded provider ref
 * without sending; otherwise the record is written `sending` BEFORE the provider is
 * called, and `sent` + the provider ref right after. Retryable failures are retried
 * inline (up to `inlineMaxMs`), then by the background sweeper, then dead-lettered.
 *
 * The Bot reaches the engine only through a few seams (`admit`, `prepareSend`,
 * `recover`/`resume`/`pause`/`stop`), each behind `if (durable)`, so a bot without
 * `durability` runs exactly the code it ran before.
 */

import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { InboundEvent, OutboundContent, SendOptions, SendResult } from '../core/provider.js'
import {
  OutsideSessionWindowError, PayloadTooLargeError, RateLimitedError, RecipientUnreachableError, UnsupportedContentError,
} from '../core/provider.js'
import { inboundDedupeKey } from '../core/dedupe.js'
import { KeyedQueue } from '../utils/keyedQueue.js'
import { parseDuration } from '../utils/duration.js'
import { ConfigValidationError } from '../utils/validateConfig.js'
import type { StoreNamespace } from '../store/NamespacedStore.js'
import { computeBackoff } from './backoff.js'
import { currentCause, nextSendKey, runWithCause, settled, type CauseRef } from './causation.js'
import { decodeInbound, decodeJson, encodedSize, encodeInbound, encodeJson } from './codec.js'
import { SendDeferredError, StaleLeaseError } from './errors.js'
import { MemoryDurability } from './memory.js'
import type {
  ClaimedSend, DurabilityBackend, DurabilityConfig, InboxJournal, InboxRecord, JsonValue, OutboxError,
  OutboxJournal, OutboxRecord, RetryBackoff,
} from './types.js'

/** Counters behind `bot.durability.metrics()`. */
export interface DurabilityMetrics {
  /** Inbound events written to the inbox. */
  inboundJournaled: number
  /** Redeliveries the inbox recognised (already done / in flight). */
  inboundDuplicates: number
  /** Journaled events processed again (restart recovery, background retry). */
  inboundReplayed: number
  /** Inbound events dead-lettered after `inbox.maxAttempts`. */
  inboundDead: number
  /** Sends written to the outbox. */
  outboxJournaled: number
  /** Sends answered from the outbox without calling the provider (already sent). */
  outboxDeduped: number
  /** Provider attempts beyond the first. */
  outboxRetried: number
  /** Sends handed to the background sweeper (`SendDeferredError`). */
  outboxDeferred: number
  /** Sends dead-lettered. */
  outboxDead: number
  /** Sends whose outcome was unknown after a crash. */
  outboxAmbiguous: number
  /** Sends that bypassed the outbox (unencodable or larger than `maxPayloadBytes`). */
  outboxBypassed: number
  /** Completions rejected because their lease had been superseded. */
  staleLeases: number
  /** Replayed sends whose content differed from the one recorded under the same derived key. */
  outboxDiverged: number
}

/** `bot.durability`: the journals plus operator controls. */
export interface DurabilityControl {
  readonly backend: DurabilityBackend
  readonly inbox: InboxJournal
  readonly outbox: OutboxJournal
  /** This process's lease owner id. */
  readonly instanceId: string
  /**
   * The scope of this bot's records in a shared backend (derived from its namespace), or
   * `undefined` when the backend has no `scope()`. `journal.scope(scope)` opens the same view.
   */
  readonly scope: string | undefined
  /** Operator replay of an inbound record (e.g. from the DLQ): it is processed again by the sweeper. */
  replayInbound(id: string): Promise<void>
  /** Operator retry of a `failed`/`dead`/`unknown` send. */
  retrySend(key: string): Promise<void>
  /** Run one sweeper pass now (retries, expired leases, purge). */
  sweep(): Promise<void>
  metrics(): DurabilityMetrics
}

interface LoggerLike {
  debug(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/** What the engine needs from its Bot. */
export interface DurableEngineDeps {
  logger: LoggerLike
  namespace: StoreNamespace
  /**
   * Run a journaled event through the normal inbound pipeline (access lists re-checked,
   * persistence, dispatch). `false` = dropped unprocessed because the bot is stopping.
   */
  replay(event: InboundEvent): Promise<boolean>
  /** The provider send. */
  transportSend(chatId: string, content: OutboundContent, options?: SendOptions): Promise<SendResult>
  /** `before('send')` hooks for a background-enqueued send (`false` = aborted). */
  beforeSend(payload: { chatId: string; content: OutboundContent; options?: SendOptions }): Promise<boolean>
  /** `after('send')` hooks + message log for a send completed in the background. */
  afterSend(payload: { chatId: string; content: OutboundContent; options?: SendOptions }, result: SendResult): Promise<void>
  emit(event: string, payload: unknown): void
  reportError(error: unknown): void
  /** Clock (epoch ms). */
  now?: () => number
}

/** A send prepared by {@link DurableEngine.prepareSend}. */
export interface DurableSend {
  /** The idempotency key (final once {@link prior} resolved: a diverged replay gets a new one). */
  readonly key: string
  /** The caller's options without `idempotencyKey`. */
  readonly options: SendOptions | undefined
  /**
   * The recorded result when this send already went out (it must not run again). `content`
   * is the send as the caller made it (before `before('send')` hooks).
   */
  prior(chatId: string, content: OutboundContent): Promise<SendResult | undefined>
  /** Journal + send + record, with inline retries. `call` invokes the provider. */
  run(payload: { chatId: string; content: OutboundContent; options?: SendOptions }, call: () => Promise<SendResult>): Promise<SendResult>
}

/** A reserved turn in a partition queue (see `DurableEngine.reserve`). */
interface PartitionSlot {
  run<T>(task: () => Promise<T>): Promise<T>
  cancel(): void
}

const SKIPPED = (chatId: string): SendResult => ({ ref: { id: 'skipped', chatId }, skipped: true })
const TERMINAL_ERRORS = new Set(['UnsupportedContentError', 'PayloadTooLargeError', 'MediaTooLargeError', 'OutsideSessionWindowError', 'RecipientUnreachableError'])

function ms(value: number | string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  let n: number
  try { n = parseDuration(value) } catch { throw new ConfigValidationError(field, "a duration ('30s', '10m') or ms", value) }
  if (!Number.isFinite(n) || n < 0) throw new ConfigValidationError(field, 'a non-negative duration', value)
  return n
}

function int(value: number | undefined, fallback: number, field: string, min: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new ConfigValidationError(field, `an integer >= ${min}`, value)
  return value
}

function isTerminal(error: unknown): boolean {
  if (error instanceof UnsupportedContentError || error instanceof PayloadTooLargeError
    || error instanceof OutsideSessionWindowError || error instanceof RecipientUnreachableError) return true
  const e = error as { name?: unknown; retryable?: unknown } | null
  if (e && e.retryable === false) return true
  return typeof e?.name === 'string' && TERMINAL_ERRORS.has(e.name)
}

function errorSummary(error: unknown): OutboxError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { name: error.name, message: error.message, ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) }
  }
  return { message: String(error) }
}

function sleep(msDelay: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, msDelay); t.unref?.() })
}

/** Validate `BotConfig.durability` and build the engine. */
export class DurableEngine implements DurabilityControl {
  readonly backend: DurabilityBackend
  readonly inbox: InboxJournal
  readonly outbox: OutboxJournal
  readonly instanceId: string

  private readonly inboxLeaseMs: number
  private readonly maxAttempts: number
  private readonly inboxBackoff: RetryBackoff | undefined
  private readonly retries: number
  private readonly outboxBackoff: RetryBackoff | undefined
  private readonly inlineMaxMs: number
  private readonly onAmbiguous: 'skip' | 'resend'
  private readonly onDiverged: 'send' | 'skip'
  /** Reclaim this instanceId's unexpired leases at start (it is stable and cannot be a live sibling). */
  private readonly reclaimOwn: boolean
  readonly scope: string | undefined
  private readonly maxPayloadBytes: number
  private readonly outboxLeaseMs: number
  private readonly pollMs: number
  private readonly retentionMs: number
  private readonly failOpen: boolean
  private readonly now: () => number

  private readonly partitions = new KeyedQueue()
  private readonly chats = new KeyedQueue()
  private readonly counters: DurabilityMetrics = {
    inboundJournaled: 0, inboundDuplicates: 0, inboundReplayed: 0, inboundDead: 0,
    outboxJournaled: 0, outboxDeduped: 0, outboxRetried: 0, outboxDeferred: 0, outboxDead: 0,
    outboxAmbiguous: 0, outboxBypassed: 0, staleLeases: 0, outboxDiverged: 0,
  }
  /** The journals are in use (between `resume()` and `stop()`). */
  private running = false
  /** Inline retries and the sweeper are on (between `resume()` and `pause()`). */
  private sweeperOn = false
  private recovered: InboxRecord[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping: Promise<void> | undefined
  private lastPurge = 0
  /** Records this process is working on (the sweeper never re-claims them). */
  private readonly inFlight = new Set<string>()
  /** Background deliveries in progress, by key (a live send of the same key waits for it). */
  private readonly deliveries = new Map<string, Promise<SendResult | undefined>>()
  /** Inbound records between claim and completion (stop() waits briefly for them). */
  private readonly processing = new Set<Promise<unknown>>()

  /** @throws {ConfigValidationError} on an invalid configuration. */
  constructor(config: DurabilityConfig, private readonly deps: DurableEngineDeps) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new ConfigValidationError('durability', '{ journal?, inbox?, outbox?, … }', config)
    }
    const journal = config.journal ?? new MemoryDurability()
    if (typeof journal !== 'object' || journal === null || typeof journal.inbox?.append !== 'function' || typeof journal.outbox?.put !== 'function') {
      throw new ConfigValidationError('durability.journal', 'a DurabilityBackend ({ inbox, outbox })', journal)
    }
    const ns = deps.namespace
    // Several bots may share one backend: each works in the view of its own namespace.
    this.scope = typeof journal.scope === 'function'
      ? createHash('sha256').update(JSON.stringify([ns.tenantId, ns.environmentId, ns.botId, ns.connectionId])).digest('hex').slice(0, 16)
      : undefined
    const view = this.scope !== undefined && journal.scope ? journal.scope(this.scope) : journal
    this.backend = view
    this.inbox = view.inbox
    this.outbox = view.outbox
    if (config.instanceId !== undefined && (typeof config.instanceId !== 'string' || config.instanceId === '')) {
      throw new ConfigValidationError('durability.instanceId', 'a non-empty string', config.instanceId)
    }
    // A stable default is only safe where no sibling process can hold the same id (single-process
    // backends). On a shared backend the default is unique per boot and own leases are never
    // reclaimed early: they may belong to a live process on the same host.
    const exclusive = journal.exclusive === true
    const base = `${hostname()}/${ns.botId}/${ns.connectionId}`
    this.instanceId = config.instanceId ?? (exclusive ? base : `${base}/${process.pid}-${randomUUID().slice(0, 8)}`)
    this.reclaimOwn = config.instanceId !== undefined || exclusive
    if (!this.reclaimOwn) {
      deps.logger.debug({ instanceId: this.instanceId }, 'durability.instanceId not set on a shared backend: a restart waits for its old leases to expire')
    }
    this.inboxLeaseMs = Math.max(1, ms(config.inbox?.leaseMs, 60_000, 'durability.inbox.leaseMs'))
    this.maxAttempts = int(config.inbox?.maxAttempts, 5, 'durability.inbox.maxAttempts', 1)
    this.inboxBackoff = config.inbox?.backoff
    this.retries = int(config.outbox?.retries, 5, 'durability.outbox.retries', 0)
    this.outboxBackoff = config.outbox?.backoff
    this.inlineMaxMs = ms(config.outbox?.inlineMaxMs, 15_000, 'durability.outbox.inlineMaxMs')
    const amb = config.outbox?.onAmbiguous ?? 'skip'
    if (amb !== 'skip' && amb !== 'resend') throw new ConfigValidationError('durability.outbox.onAmbiguous', "'skip' | 'resend'", amb)
    this.onAmbiguous = amb
    const div = config.outbox?.onDiverged ?? 'send'
    if (div !== 'send' && div !== 'skip') throw new ConfigValidationError('durability.outbox.onDiverged', "'send' | 'skip'", div)
    this.onDiverged = div
    this.maxPayloadBytes = int(config.outbox?.maxPayloadBytes, 1024 * 1024, 'durability.outbox.maxPayloadBytes', 1)
    this.outboxLeaseMs = Math.max(1, ms(config.outbox?.leaseMs, 60_000, 'durability.outbox.leaseMs'))
    this.pollMs = Math.max(10, ms(config.pollMs, 1_000, 'durability.pollMs'))
    this.retentionMs = ms(config.retention, 7 * 24 * 3600_000, 'durability.retention')
    this.failOpen = config.failOpen === true
    this.now = deps.now ?? (() => Date.now())
  }

  metrics(): DurabilityMetrics { return { ...this.counters } }

  /* ------------------------------------------------------------------------
   * Lifecycle
   * --------------------------------------------------------------------- */

  /** `bot.start()`, before the provider starts: open the backend and reclaim what a previous run left in flight. */
  async recover(): Promise<void> {
    await this.backend.start?.()
    const now = this.now()
    // Sends a previous incarnation of this instance left `sending` are ambiguous: settle them
    // before anything is replayed, so a replayed handler finds them resolved.
    const leftovers = await this.outbox.claimDue({ owner: this.instanceId, leaseMs: this.outboxLeaseMs, now, limit: 10_000, reclaimOwn: this.reclaimOwn })
    for (const c of leftovers) {
      if (c.ambiguous) await this.resolveAmbiguous(c)
      else await this.settleSend(c.record, () => this.outbox.resolveAmbiguous(c.record.key, c.record.fencingToken, 'pending', now))
    }
    this.recovered = await this.inbox.claim({ owner: this.instanceId, leaseMs: this.inboxLeaseMs, now, limit: 10_000, reclaimOwn: this.reclaimOwn })
  }

  /**
   * `bot.start()`, once inbound is accepted: queue the recovered records (each ahead of
   * any live message of its chat) and start the sweeper. Synchronous on purpose.
   */
  resume(): void {
    this.running = true
    this.sweeperOn = true
    const recovered = this.recovered
    this.recovered = []
    for (const record of recovered) this.spawnReplay(record)
    this.timer = setInterval(() => { void this.sweep() }, this.pollMs)
    this.timer.unref?.()
    void this.runSweep(this.reclaimOwn)
  }

  /**
   * `bot.stop()`, as inbound closes: stop the sweeper; inline retries give up (the outbox
   * keeps them for the next start). Sends still in flight keep being journaled until {@link stop}.
   */
  pause(): void {
    this.sweeperOn = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** `bot.stop()` after the provider stopped (and on a failed start): close the backend. */
  async stop(): Promise<void> {
    this.pause()
    await this.sweeping?.catch(() => {})
    // Let records whose steps already settled (or were aborted by stop) record it; a handler
    // that never returns keeps its lease, which expires and is replayed later.
    if (this.processing.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...this.processing]),
        new Promise<void>((r) => { timer = setTimeout(r, 1_000) }),
      ])
      if (timer) clearTimeout(timer)
    }
    this.running = false
    await this.backend.stop?.()
  }

  /* ------------------------------------------------------------------------
   * Inbound
   * --------------------------------------------------------------------- */

  private recordId(event: InboundEvent): { id: string; idempotencyKey?: string } {
    const dk = inboundDedupeKey(event)
    if (!dk) return { id: randomUUID() }
    const ns = this.deps.namespace
    const idempotencyKey = `${dk.key}|${dk.fingerprint}`
    const id = createHash('sha256')
      .update(JSON.stringify([ns.tenantId, ns.environmentId, ns.botId, ns.connectionId, idempotencyKey]))
      .digest('hex').slice(0, 40)
    return { id, idempotencyKey }
  }

  private partitionOf(chatId: string): string {
    const ns = this.deps.namespace
    return JSON.stringify([ns.tenantId, ns.environmentId, ns.botId, ns.connectionId, chatId])
  }

  /**
   * Live path for one admitted message/interaction. Resolves `false` when the event must
   * be forgotten by the in-memory deduper (journal unavailable, or the bot stopped before
   * running it), `true` otherwise. Rejects with the pipeline's error.
   */
  async admit(event: InboundEvent, handle: () => Promise<boolean>): Promise<boolean> {
    const payload = encodeInbound(event)
    if (!this.running || payload === undefined) return (await handle()) !== false
    const chatId = event.kind === 'message' ? event.message.chatId : event.kind === 'interaction' ? event.interaction.chatId : ''
    const { id, idempotencyKey } = this.recordId(event)
    const partitionKey = this.partitionOf(chatId)
    // Take this event's place in its chat's queue NOW (events arrive in order, appends may
    // finish out of order): the slot runs the event or is given up, never left waiting.
    const slot = this.reserve(partitionKey)
    const lease = { owner: this.instanceId, leaseMs: this.inboxLeaseMs, now: this.now() }
    let record: InboxRecord | null
    try {
      const appended = await this.inbox.append({
        id, ...(idempotencyKey ? { idempotencyKey } : {}),
        partitionKey,
        kind: event.kind === 'interaction' ? 'interaction' : 'message',
        payload,
        receivedAt: lease.now,
      }, lease.now, lease)
      if (appended.status === 'appended') {
        record = appended.record
        this.counters.inboundJournaled++
      } else {
        record = this.inFlight.has(id) ? null : await this.inbox.claimOne(id, lease)
        if (!record) {
          slot.cancel()
          this.counters.inboundDuplicates++
          this.deps.logger.debug({ id, state: appended.record.state }, 'inbound redelivery already journaled')
          return true
        }
      }
    } catch (error) {
      this.deps.reportError(error)
      if (this.failOpen) return (await slot.run(handle)) !== false
      slot.cancel()
      return false
    }
    return this.process(record, handle, false, slot)
  }

  /** Reserve the next turn of `partitionKey`'s queue; it waits until `run` or `cancel` is called. */
  private reserve(partitionKey: string): PartitionSlot {
    let start!: (task: () => Promise<unknown>) => void
    const given = new Promise<() => Promise<unknown>>((r) => { start = r })
    const turn = this.partitions.run(partitionKey, async () => (await given)())
    return {
      run: <T>(task: () => Promise<T>) => { start(task); return turn as Promise<T> },
      cancel: () => { start(async () => undefined); void turn.catch(() => {}) },
    }
  }

  private spawnReplay(record: InboxRecord): void {
    // Each claim is charged: a record past maxAttempts never completed any of them (the
    // process died while running it, e.g. a message that crashes it). Dead-letter it
    // instead of replaying it into another crash.
    if (record.attempts > this.maxAttempts) {
      void this.complete(record, 'dead', new Error(`not completed after ${record.attempts - 1} attempts (the process stopped while running it)`))
      return
    }
    let event: InboundEvent
    try { event = decodeInbound(record.payload) } catch (error) {
      void this.complete(record, 'dead', error)
      return
    }
    this.counters.inboundReplayed++
    this.process(record, () => this.deps.replay(event), true)
      .catch((error) => this.deps.reportError(error))
  }

  /**
   * Process a claimed record in its partition's order; settle → ack outside the queue.
   * Runs in `slot`: reserved by `admit` before the append (live events keep their arrival
   * order), or by default taken synchronously here.
   */
  private process(
    record: InboxRecord,
    handle: () => Promise<boolean>,
    replay: boolean,
    slot: PartitionSlot = this.reserve(record.partitionKey),
  ): Promise<boolean> {
    this.inFlight.add(record.id)
    const lease = { id: record.id, token: record.fencingToken }
    const heartbeat = setInterval(() => {
      // Once the journals are closed the lease is left to expire (the record is replayed later).
      if (!this.running) return
      this.inbox.extend(lease.id, lease.token, this.now() + this.inboxLeaseMs).catch((error) => {
        if (error instanceof StaleLeaseError) this.counters.staleLeases++
        this.deps.logger.warn({ err: error, id: lease.id }, 'inbox lease heartbeat failed')
      })
    }, Math.max(5, Math.floor(this.inboxLeaseMs / 3)))
    heartbeat.unref?.()

    type Step = { kind: 'ok'; ref: CauseRef } | { kind: 'stopped' } | { kind: 'error'; error: unknown }
    const step = slot.run(async (): Promise<Step> => {
      try {
        const { ref, result } = runWithCause(record.id, handle, { replay })
        return (await result) === false ? { kind: 'stopped' } : { kind: 'ok', ref }
      } catch (error) {
        return { kind: 'error', error }
      }
    })

    const done = step.then(async (s) => {
      try {
        if (s.kind === 'ok') {
          const outcome = await settled(s.ref)
          await this.complete(record, outcome === 'aborted' ? 'release' : 'ack')
          return true
        }
        if (s.kind === 'stopped') { await this.complete(record, 'release'); return false }
        await this.complete(record, 'fail', s.error)
        throw s.error
      } finally {
        clearInterval(heartbeat)
        this.inFlight.delete(record.id)
      }
    })
    const tracked = done.catch(() => undefined)
    this.processing.add(tracked)
    void tracked.then(() => this.processing.delete(tracked))
    return done
  }

  private async complete(record: InboxRecord, how: 'ack' | 'release' | 'fail' | 'dead', error?: unknown): Promise<void> {
    const now = this.now()
    try {
      if (how === 'ack') await this.inbox.ack(record.id, record.fencingToken, now)
      else if (how === 'release') await this.inbox.release(record.id, record.fencingToken, now)
      else {
        const dead = how === 'dead' || record.attempts >= this.maxAttempts
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        await this.inbox.fail(record.id, record.fencingToken, message, {
          now, dead, ...(dead ? {} : { retryAt: now + computeBackoff(this.inboxBackoff, record.attempts) }),
        })
        if (dead) {
          this.counters.inboundDead++
          this.deps.emit('durability:dead', { kind: 'inbound', id: record.id, error })
        }
      }
    } catch (e) {
      if (e instanceof StaleLeaseError) {
        this.counters.staleLeases++
        this.deps.logger.warn({ id: record.id, token: record.fencingToken }, 'inbox completion rejected: lease superseded')
      } else {
        this.deps.reportError(e)
      }
    }
  }

  /* ------------------------------------------------------------------------
   * Outbound
   * --------------------------------------------------------------------- */

  /** Derive the send's idempotency key and strip it from the options. */
  prepareSend(options: SendOptions | undefined): DurableSend {
    let stripped = options
    let explicit: string | undefined
    if (options && 'idempotencyKey' in options) {
      const { idempotencyKey, ...rest } = options as SendOptions & { idempotencyKey?: string }
      explicit = idempotencyKey
      stripped = rest
    }
    const cause = currentCause()
    const derived = explicit === undefined ? nextSendKey() : undefined
    let key = explicit ?? derived ?? `rnd:${randomUUID()}`
    let fingerprint: string | undefined
    const active = this.running
    return {
      get key() { return key },
      options: stripped,
      prior: async (chatId, content) => {
        if (!active) return undefined
        fingerprint = this.fingerprintOf(chatId, content)
        const resolved = await this.resolveKey(key, derived !== undefined, fingerprint, chatId)
        key = resolved.key
        const r = resolved.record
        if (!r) return undefined
        if (r.state === 'sent' && r.result) { this.counters.outboxDeduped++; return { ref: { ...r.result.ref } } }
        if (r.state === 'unknown' || r.state === 'dead') { this.counters.outboxDeduped++; return SKIPPED(r.chatId) }
        return undefined
      },
      run: (payload, call) => active ? this.runSend(key, cause?.id, payload, call, fingerprint) : call(),
    }
  }

  /** Hash of a send's chat + encoded content (`undefined` when it cannot be encoded). */
  private fingerprintOf(chatId: string, content: OutboundContent): string | undefined {
    const encoded = encodeJson(content)
    if (encoded === undefined) return undefined
    return createHash('sha256').update(JSON.stringify([chatId, encoded])).digest('hex').slice(0, 32)
  }

  /**
   * The record under `key`, unless `key` is derived (`<inboundId>:<n>`) and the record holds
   * different content: the replay took another path, so (policy `'send'`) the send moves to
   * `<key>~<fingerprint>` — itself idempotent across later replays.
   */
  private async resolveKey(key: string, derived: boolean, fingerprint: string | undefined, chatId: string): Promise<{ key: string; record: OutboxRecord | undefined }> {
    const record = await this.outbox.get(key)
    if (!record || !derived || fingerprint === undefined || record.fingerprint === undefined || record.fingerprint === fingerprint) {
      return { key, record }
    }
    this.counters.outboxDiverged++
    this.deps.logger.warn({ key, chatId, policy: this.onDiverged }, 'replayed send differs from the one recorded under its key')
    if (this.onDiverged === 'skip') return { key, record }
    const moved = `${key}~${fingerprint.slice(0, 12)}`
    return { key: moved, record: await this.outbox.get(moved) }
  }

  private encodeSend(payload: { content: OutboundContent; options?: SendOptions }): { content: JsonValue; options?: JsonValue } | undefined {
    const content = encodeJson(payload.content)
    const options = payload.options === undefined ? undefined : encodeJson(payload.options)
    if (content === undefined || (payload.options !== undefined && options === undefined)) return undefined
    if (encodedSize(content) + (options === undefined ? 0 : encodedSize(options)) > this.maxPayloadBytes) return undefined
    return options === undefined ? { content } : { content, options }
  }

  private runSend(
    key: string,
    causationId: string | undefined,
    payload: { chatId: string; content: OutboundContent; options?: SendOptions },
    call: () => Promise<SendResult>,
    fingerprint: string | undefined,
  ): Promise<SendResult> {
    const encoded = this.encodeSend(payload)
    if (!encoded) {
      this.counters.outboxBypassed++
      this.deps.logger.warn({ key, chatId: payload.chatId, kind: payload.content.kind }, 'send bypasses the outbox (unencodable or above maxPayloadBytes)')
      return call()
    }
    const running = this.deliveries.get(key)
    if (running) return this.awaitDelivery(key, running)
    const outcome = this.chats.run(payload.chatId, async (): Promise<SendResult | { wait: Promise<SendResult | undefined> }> => {
      const startedAt = this.now()
      const lease = { owner: this.instanceId, leaseMs: this.outboxLeaseMs, now: startedAt }
      let record: OutboxRecord | null
      try {
        const put = await this.outbox.put({
          key, chatId: payload.chatId, ...(causationId ? { causationId } : {}), ...encoded,
          ...(fingerprint ? { fingerprint } : {}), createdAt: startedAt,
        }, startedAt, lease)
        record = put.record
        if (put.status === 'created') this.counters.outboxJournaled++
        else {
          for (;;) {
            // Being sent elsewhere: by our own sweeper (queued behind this send — wait for it outside
            // the chat queue), or by another replica (poll its outcome within the inline window).
            while (record.state === 'sending') {
              const queued = this.deliveries.get(key)
              if (queued) return { wait: queued }
              if (this.now() - startedAt >= this.inlineMaxMs || (record.leaseUntil ?? 0) <= this.now()) break
              await sleep(25)
              record = (await this.outbox.get(key)) ?? record
            }
            if (record.state === 'sent' && record.result) { this.counters.outboxDeduped++; return { ref: { ...record.result.ref } } }
            if (record.state === 'unknown' || record.state === 'dead') { this.counters.outboxDeduped++; return SKIPPED(record.chatId) }
            if (this.inFlight.has(key)) throw new SendDeferredError(key)
            const begun = await this.outbox.begin(key, { ...lease, now: this.now() })
            if (begun) { record = begun; break }
            // Lost the race to a sweeper (ours or another replica's) that claimed the record
            // between the put and the begin: follow that delivery instead of deferring.
            const queued = this.deliveries.get(key)
            if (queued) return { wait: queued }
            const fresh = await this.outbox.get(key)
            // Still claimable here (pending/failed, not due) or out of time: defer as before.
            if (!fresh || fresh.state === 'pending' || fresh.state === 'failed' || this.now() - startedAt >= this.inlineMaxMs) {
              throw new SendDeferredError(key)
            }
            record = fresh
          }
        }
      } catch (error) {
        if (error instanceof SendDeferredError || !this.failOpen) throw error
        this.deps.reportError(error)
        return call()
      }
      this.inFlight.add(key)
      try {
        return await this.attempt(record, call, startedAt, true)
      } finally {
        this.inFlight.delete(key)
      }
    })
    return outcome.then((o) => ('wait' in o ? this.awaitDelivery(key, o.wait) : o))
  }

  private async awaitDelivery(key: string, delivery: Promise<SendResult | undefined>): Promise<SendResult> {
    const result = await delivery
    if (!result) throw new SendDeferredError(key)
    this.counters.outboxDeduped++
    return { ref: { ...result.ref } }
  }

  /**
   * Call the provider for a `sending` record and record the outcome. Inline (a caller is
   * waiting) it retries while within `inlineMaxMs`, then defers; in the background it
   * records one attempt and leaves the next to the sweeper.
   */
  private async attempt(record: OutboxRecord, call: () => Promise<SendResult>, startedAt: number, inline: boolean): Promise<SendResult> {
    for (;;) {
      let result: SendResult
      try {
        result = await this.withSendLease(record, call)
      } catch (error) {
        const now = this.now()
        if (isTerminal(error) || record.attempts > this.retries) {
          await this.settleSend(record, () => this.outbox.markFailed(record.key, record.fencingToken, errorSummary(error), { now, dead: true }))
          this.counters.outboxDead++
          this.deps.emit('durability:dead', { kind: 'outbound', id: record.key, chatId: record.chatId, error })
          throw error
        }
        let wait = computeBackoff(this.outboxBackoff, record.attempts)
        if (error instanceof RateLimitedError || (error as { name?: unknown })?.name === 'RateLimitedError') {
          wait = Math.max(wait, Number((error as RateLimitedError).retryAfterMs) || 0)
        }
        const keepInline = inline && this.sweeperOn && now + wait - startedAt <= this.inlineMaxMs
        // While retrying inline, the record stays out of the sweeper's reach until just after the wait.
        const retryAt = now + wait + (keepInline ? this.pollMs * 2 + 1_000 : 0)
        await this.settleSend(record, () => this.outbox.markFailed(record.key, record.fencingToken, errorSummary(error), { now, retryAt }))
        if (!keepInline) {
          if (inline) {
            this.counters.outboxDeferred++
            throw new SendDeferredError(record.key, error)
          }
          throw error
        }
        await sleep(wait)
        const again = this.sweeperOn ? await this.outbox.begin(record.key, { owner: this.instanceId, leaseMs: this.outboxLeaseMs, now: this.now() }) : null
        if (!again) {
          this.counters.outboxDeferred++
          throw new SendDeferredError(record.key, error)
        }
        record = again
        this.counters.outboxRetried++
        continue
      }
      // Sent. A failure to record it leaves the record `sending`: after a crash it is
      // ambiguous (never re-sent under the default 'skip' policy).
      await this.settleSend(record, () => this.outbox.markSent(record.key, record.fencingToken, { ref: result.ref }, this.now()))
      return result
    }
  }

  /**
   * Run the provider call while extending the record's lease, so a slow send (large upload,
   * provider-side queue) is never taken for an abandoned one by another replica's sweeper.
   */
  private async withSendLease(record: OutboxRecord, call: () => Promise<SendResult>): Promise<SendResult> {
    const { key, fencingToken } = record
    let beat: Promise<void> | undefined
    const heartbeat = setInterval(() => {
      if (!this.running || beat) return
      beat = this.outbox.extend(key, fencingToken, this.now() + this.outboxLeaseMs)
        .catch((error: unknown) => {
          if (error instanceof StaleLeaseError) this.counters.staleLeases++
          this.deps.logger.warn({ err: error, key }, 'outbox lease heartbeat failed')
        })
        .finally(() => { beat = undefined })
    }, Math.max(5, Math.floor(this.outboxLeaseMs / 3)))
    heartbeat.unref?.()
    try {
      return await call()
    } finally {
      clearInterval(heartbeat)
      await beat
    }
  }

  private async settleSend(record: OutboxRecord, write: () => Promise<void>): Promise<void> {
    try { await write() } catch (error) {
      if (error instanceof StaleLeaseError) {
        this.counters.staleLeases++
        this.deps.logger.warn({ key: record.key, token: record.fencingToken }, 'outbox completion rejected: lease superseded')
      } else {
        this.deps.reportError(error)
      }
    }
  }

  /**
   * Durable fire-and-forget send (`bot.enqueue`): `before('send')` hooks run now, the
   * send is journaled `pending` and delivered by the sweeper (right away, then with
   * retries). Enqueueing a key that already exists is a no-op.
   */
  async enqueue(chatId: string, content: OutboundContent, opts: SendOptions & { idempotencyKey?: string } = {}): Promise<{ key: string; status: 'queued' | 'exists' | 'skipped' }> {
    const { idempotencyKey, ...options } = opts
    const derived = idempotencyKey === undefined ? nextSendKey() : undefined
    const fingerprint = this.fingerprintOf(chatId, content)
    const { key, record: existing } = await this.resolveKey(idempotencyKey ?? derived ?? `rnd:${randomUUID()}`, derived !== undefined, fingerprint, chatId)
    if (existing) return { key, status: 'exists' }
    const payload: { chatId: string; content: OutboundContent; options?: SendOptions } = {
      chatId, content, ...(Object.keys(options).length ? { options } : {}),
    }
    if (!(await this.deps.beforeSend(payload))) return { key, status: 'skipped' }
    const encoded = this.encodeSend(payload)
    if (!encoded) throw new TypeError('bot.enqueue(): content cannot be journaled (a stream, or larger than durability.outbox.maxPayloadBytes)')
    const now = this.now()
    const cause = currentCause()
    const put = await this.outbox.put({
      key, chatId: payload.chatId, ...(cause ? { causationId: cause.id } : {}), ...encoded, ...(fingerprint ? { fingerprint } : {}), createdAt: now,
    }, now)
    if (put.status === 'created') this.counters.outboxJournaled++
    if (this.sweeperOn) void this.sweep()
    return { key, status: put.status === 'created' ? 'queued' : 'exists' }
  }

  /** Settle an ambiguous claim per `onAmbiguous`: `unknown` (skip) or `pending` (resend, by whoever runs next). */
  private async resolveAmbiguous(c: ClaimedSend): Promise<void> {
    const record = c.record
    this.counters.outboxAmbiguous++
    this.deps.emit('durability:ambiguous', { key: record.key, chatId: record.chatId })
    const to = this.onAmbiguous === 'skip' ? 'unknown' : 'pending'
    await this.settleSend(record, () => this.outbox.resolveAmbiguous(record.key, record.fencingToken, to, this.now()))
  }

  /** Deliver one send claimed by the sweeper. */
  private async deliverClaimed(c: ClaimedSend): Promise<void> {
    const record = c.record
    if (c.ambiguous) {
      // Resolved first (a `'resend'` record becomes `pending` and goes out on the next pass).
      await this.resolveAmbiguous(c)
      return
    }
    const payload: { chatId: string; content: OutboundContent; options?: SendOptions } = {
      chatId: record.chatId,
      content: decodeJson<OutboundContent>(record.content),
      ...(record.options !== undefined ? { options: decodeJson<SendOptions>(record.options) } : {}),
    }
    const delivery = this.chats.run(record.chatId, async (): Promise<SendResult | undefined> => {
      this.inFlight.add(record.key)
      try {
        if (record.attempts > 1) this.counters.outboxRetried++
        const result = await this.attempt(record, () => this.deps.transportSend(payload.chatId, payload.content, payload.options), this.now(), false)
        await this.deps.afterSend(payload, result)
        return result
      } catch (error) {
        this.deps.logger.debug({ key: record.key, err: error instanceof Error ? error.message : String(error) }, 'background send attempt failed')
        return undefined
      } finally {
        this.inFlight.delete(record.key)
      }
    })
    this.deliveries.set(record.key, delivery)
    try { await delivery } finally { this.deliveries.delete(record.key) }
  }

  /* ------------------------------------------------------------------------
   * Sweeper + operator controls
   * --------------------------------------------------------------------- */

  sweep(): Promise<void> { return this.runSweep(false) }

  private runSweep(reclaimOwn: boolean): Promise<void> {
    if (this.sweeping) return this.sweeping
    const pass = (async () => {
      const now = this.now()
      const notMine = (k: string) => !this.inFlight.has(k)
      try {
        const records = await this.inbox.claim({ owner: this.instanceId, leaseMs: this.inboxLeaseMs, now, limit: 100 })
        for (const r of records) {
          if (this.inFlight.has(r.id)) continue
          this.spawnReplay(r)
        }
      } catch (error) { this.deps.logger.warn({ err: error }, 'inbox sweep failed') }
      try {
        const sends = await this.outbox.claimDue({ owner: this.instanceId, leaseMs: this.outboxLeaseMs, now, limit: 100, reclaimOwn })
        for (const c of sends) {
          if (!notMine(c.record.key)) continue
          void this.deliverClaimed(c)
        }
      } catch (error) { this.deps.logger.warn({ err: error }, 'outbox sweep failed') }
      if (this.retentionMs > 0 && now - this.lastPurge >= 60_000) {
        this.lastPurge = now
        try {
          await this.inbox.purge({ doneBefore: now - this.retentionMs })
          await this.outbox.purge({ before: now - this.retentionMs })
        } catch (error) { this.deps.logger.warn({ err: error }, 'durability purge failed') }
      }
    })()
    this.sweeping = pass.finally(() => { this.sweeping = undefined })
    return this.sweeping
  }

  async replayInbound(id: string): Promise<void> {
    await this.inbox.replay(id, this.now())
    if (this.sweeperOn) await this.sweep()
  }

  async retrySend(key: string): Promise<void> {
    await this.outbox.retry(key, this.now())
    if (this.sweeperOn) await this.sweep()
  }
}

