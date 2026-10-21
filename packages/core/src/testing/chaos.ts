/**
 * Chaos testing kit — adversarial, seeded delivery for any {@link IProvider}.
 *
 * Real transports are not polite: webhooks are retried (duplicates), arrive out
 * of order, take variable time, sends fail transiently with typed errors, the
 * socket drops mid-conversation and replays recent messages on reconnect, and
 * the same human can show up under different wire identities (WhatsApp LID vs
 * PN). The worst historical bug in this project — one person split across two
 * conversation keys — escaped because the test double was always polite.
 *
 * {@link ChaosProvider} decorates a provider (usually `MockProvider`, but any
 * `IProvider` works) and injects that misbehaviour between the provider and its
 * listeners (the Bot):
 *
 * | option          | what it simulates                                              |
 * | --------------- | -------------------------------------------------------------- |
 * | `duplicates`    | webhook retries / socket replays (fresh copies of one event)   |
 * | `reorder`       | out-of-order delivery inside a sliding window                  |
 * | `latency`       | per-event inbound delay (ranges reorder events naturally)      |
 * | `sendFailures`  | transient outbound failures as typed `ProviderError`s          |
 * | `sendLatency`   | slow outbound sends                                            |
 * | `disconnects`   | `closed → connecting → ready` drops, held inbound, replays     |
 * | `aliases`       | the same human under several wire ids (identity flips)         |
 *
 * Everything is **deterministic for a given `seed`** and the same sequence of
 * calls: inbound, outbound, connection and identity decisions use independent
 * PRNG streams, so adding a reply in a handler does not change which inbound
 * events get duplicated. Delays run on an internal ordered queue (virtual due
 * time per synchronous burst, then creation order), so real-timer jitter can
 * postpone a delivery but never swap two that were scheduled together. Use
 * `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` for exact timing, or
 * `await chaos.settle()` with real timers. (When a test interleaves `await`s
 * with arrivals, which events share a partially filled reorder window still
 * depends on wall-clock time unless timers are faked.)
 *
 * Inbound pipeline per event: alias flip → reorder window (arrival order) →
 * duplicate copies + latency → (held while disconnected) → delivered to
 * listeners. Connection events from the wrapped provider always pass straight
 * through; other kinds pass through untouched unless listed in `kinds`.
 *
 * @example
 * ```ts
 * import { createTestBot } from '@botmesh/core/testing'
 *
 * const { bot, provider, chaos } = await createTestBot({}, {
 *   chaos: { seed: 7, duplicates: 0.3, reorder: 3, latency: { min: 0, max: 5 },
 *            sendFailures: { attempts: [2], errors: ['rate-limited'] } },
 * })
 * bot.when('hola', async (ctx) => await ctx.reply('👋'))
 * provider.incoming('hola', { from: 'u1' })
 * await chaos.settle()
 * ```
 */

import type {
  ChatId,
  ConnectionUpdate,
  DisconnectReason,
  IProvider,
  InboundEvent,
  InboundListener,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  UserId,
} from '../core/provider.js'
import {
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
  OutsideSessionWindowError,
  UnsupportedContentError,
} from '../core/provider.js'
import { TimeoutError } from '../utils/timers.js'

/* ============================================================================
 * PRNG
 * ========================================================================== */

/**
 * Deterministic PRNG (mulberry32). Same seed → same sequence of floats in
 * `[0, 1)`. Exposed so tests can derive their own reproducible choices.
 */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ============================================================================
 * OPTIONS
 * ========================================================================== */

/** Inclusive millisecond range; each use draws a value from it (seeded). */
export interface ChaosRange {
  min: number
  max: number
}

/** A fixed delay in ms, or a {@link ChaosRange} drawn per use. */
export type ChaosDelay = number | ChaosRange

/** Webhook-style redelivery of inbound events. */
export interface ChaosDuplicateOptions {
  /** Probability `[0, 1]` that an inbound event is redelivered. Default `1`. */
  probability?: number
  /** Extra copies per redelivered event. Positive integer; default `1`. */
  copies?: number
  /**
   * Delay of each copy after the original. `0` (default) delivers the copy in
   * the same tick, right after the original — the hardest case for
   * idempotency, since nothing has been processed yet.
   */
  delayMs?: ChaosDelay
}

/** Out-of-order delivery within a sliding window. */
export interface ChaosReorderOptions {
  /** Events held and permuted together. Integer `>= 2`. */
  window: number
  /** A partially filled window is flushed after this many ms. Default `5`. */
  maxHoldMs?: number
  /** `'shuffle'` (seeded Fisher–Yates, default) or `'reverse'` (deterministic worst case). */
  strategy?: 'shuffle' | 'reverse'
}

/**
 * Built-in failure kinds, each mapped to the typed core error a real provider
 * would reject with:
 * - `'rate-limited'` → `RateLimitedError(retryAfterMs)`
 * - `'unreachable'` → `RecipientUnreachableError(chatId)`
 * - `'payload-too-large'` → `PayloadTooLargeError`
 * - `'outside-window'` → `OutsideSessionWindowError(chatId)`
 * - `'unsupported'` → `UnsupportedContentError(content.kind)`
 * - `'disconnected'` → {@link ChaosDisconnectedError} (a `ProviderError`)
 */
export type ChaosSendErrorKind =
  | 'rate-limited'
  | 'unreachable'
  | 'payload-too-large'
  | 'outside-window'
  | 'unsupported'
  | 'disconnected'

/** The send attempt a failure is being decided for (1-based `attempt`). */
export interface ChaosSendAttempt {
  attempt: number
  chatId: ChatId
  content: OutboundContent
  options?: SendOptions
}

/** Custom failure: build any error (ideally a `ProviderError` subclass) for an attempt. */
export type ChaosErrorFactory = (attempt: ChaosSendAttempt) => Error

/** Transient outbound failures. */
export interface ChaosSendFailureOptions {
  /**
   * Probability `[0, 1]` that a send fails. Defaults to `1`, or to `0` when
   * `attempts` is given (scripted failures only).
   */
  probability?: number
  /** 1-based send attempts that always fail (deterministic script), e.g. `[1, 3]`. */
  attempts?: number[]
  /**
   * Failure kinds/factories used in order, cycling (1st failure → `errors[0]`,
   * 2nd → `errors[1]`, …). Default `['rate-limited']`.
   */
  errors?: Array<ChaosSendErrorKind | ChaosErrorFactory>
  /** `retryAfterMs` carried by `'rate-limited'` failures. Default `1000`. */
  retryAfterMs?: number
  /**
   * Longest streak of probabilistic failures before a send is forced through
   * (keeps failures transient). Default `Infinity`.
   */
  maxConsecutive?: number
}

/** Connection drops and reconnects. */
export interface ChaosDisconnectOptions {
  /** Drop the connection right after the Nth delivered inbound event (1-based). */
  afterInbound?: number[]
  /** Probability `[0, 1]` of a drop after each delivered inbound event. Default `0`. */
  probability?: number
  /** Downtime before the automatic reconnect of these drops. Default `10` ms; `Infinity` = until `reconnect()`. */
  downtimeMs?: number
  /** Reason carried by the `closed` update. Default `'transient'`. */
  reason?: DisconnectReason
  /** Reject sends while down with {@link ChaosDisconnectedError}. Default `true`. */
  failSendsWhileDown?: boolean
  /** Hold inbound events while down and deliver them after the reconnect. Default `true`. */
  holdInboundWhileDown?: boolean
  /** On reconnect, redeliver this many of the most recently delivered events (offline-sync replay). Default `0`. */
  replayOnReconnect?: number
}

/** The same human seen under several wire identities. */
export interface ChaosAliasOptions {
  /** Canonical user id → alias ids of the same human (e.g. `{ [pn]: [lid] }`). */
  map: Record<UserId, UserId[]>
  /** `'random'` (default): flip with `probability`. `'cycle'`: canonical, alias1, alias2, canonical, … per human. */
  strategy?: 'random' | 'cycle'
  /** Probability `[0, 1]` that a mapped human's event uses an alias (strategy `'random'`). Default `0.5`. */
  probability?: number
  /**
   * Identity resolver under test, applied to the flipped wire id (e.g. a
   * provider's alias store). Omit it to simulate a provider that LEAKS aliases,
   * i.e. violates the identity stability contract.
   */
  resolve?: (wireId: UserId) => UserId
}

/** All chaos knobs. Every field is optional; `{}` is a transparent wrapper. */
export interface ChaosOptions {
  /** PRNG seed. Same seed + same call sequence → same chaos. Default `1`. */
  seed?: number
  /** A probability, or full {@link ChaosDuplicateOptions}. */
  duplicates?: number | ChaosDuplicateOptions
  /** A window size, or full {@link ChaosReorderOptions}. */
  reorder?: number | ChaosReorderOptions
  /** Inbound delay per event. */
  latency?: ChaosDelay
  /** A probability, or full {@link ChaosSendFailureOptions}. */
  sendFailures?: number | ChaosSendFailureOptions
  /** Outbound delay per send. */
  sendLatency?: ChaosDelay
  /** Automatic connection drops (manual ones: {@link ChaosProvider.disconnect}). */
  disconnects?: ChaosDisconnectOptions
  /** Alias identities for the same human. */
  aliases?: ChaosAliasOptions
  /**
   * Inbound event kinds the chaos applies to. Default `['message', 'interaction']`.
   * `connection` events always pass straight through.
   */
  kinds?: ReadonlyArray<InboundEvent['kind']>
}

/** One thing the kit injected, in order (see {@link ChaosProvider.log}). */
export type ChaosLogEntry =
  | { type: 'duplicate'; ref: string; copies: number }
  | { type: 'latency'; ms: number }
  | { type: 'reorder'; size: number; order: number[] }
  | { type: 'alias'; canonical: UserId; wire: UserId; emitted: UserId }
  | { type: 'hold'; held: number }
  | { type: 'disconnect'; reason: DisconnectReason }
  | { type: 'reconnect' }
  | { type: 'replay'; count: number }
  | { type: 'send-failure'; attempt: number; chatId: ChatId; error: string }

/**
 * Rejected by {@link ChaosProvider.send} while the simulated connection is down
 * (or for the `'disconnected'` failure kind). A `ProviderError`, like the
 * errors real providers reject with.
 */
export class ChaosDisconnectedError extends ProviderError {
  constructor(public readonly chatId: ChatId, message?: string) {
    super(message ?? `Connection closed; cannot send to ${chatId}`)
    this.name = 'ChaosDisconnectedError'
  }
}

/* ============================================================================
 * PROVIDER DECORATOR
 * ========================================================================== */

type Timer = ReturnType<typeof setTimeout>
type EventKind = InboundEvent['kind']

interface ScheduledTask {
  due: number
  seq: number
  run: () => void
}

/**
 * Deterministic timer queue. Every task gets a virtual due time — one shared
 * base per synchronous burst plus its delay — and tasks always run from the
 * head of a queue sorted by `(due, seq)`. Real-timer jitter (Node may stamp two
 * timers created in one burst with different milliseconds, and orders equal
 * expiries of different durations arbitrarily) can delay a task but never
 * reorder two of them.
 */
class OrderedScheduler {
  private queue: ScheduledTask[] = []
  private seq = 0
  private base: number | undefined
  private armed: { handle: Timer; due: number } | undefined

  get size(): number { return this.queue.length }

  schedule(delayMs: number, run: () => void): ScheduledTask {
    const task: ScheduledTask = { due: this.burstBase() + delayMs, seq: this.seq++, run }
    let i = this.queue.length
    while (i > 0 && (this.queue[i - 1].due > task.due || (this.queue[i - 1].due === task.due && this.queue[i - 1].seq > task.seq))) i--
    this.queue.splice(i, 0, task)
    this.arm()
    return task
  }

  cancel(task: ScheduledTask | undefined): void {
    if (!task) return
    const i = this.queue.indexOf(task)
    if (i >= 0) this.queue.splice(i, 1)
    this.arm()
  }

  clear(): void {
    this.queue = []
    if (this.armed) clearTimeout(this.armed.handle)
    this.armed = undefined
  }

  private burstBase(): number {
    if (this.base === undefined) {
      this.base = Date.now()
      queueMicrotask(() => { this.base = undefined })
    }
    return this.base
  }

  private arm(): void {
    const head = this.queue[0]
    if (this.armed && (!head || this.armed.due !== head.due)) {
      clearTimeout(this.armed.handle)
      this.armed = undefined
    }
    if (!head || this.armed) return
    this.armed = { handle: setTimeout(() => this.fire(), Math.max(0, head.due - Date.now())), due: head.due }
  }

  private fire(): void {
    this.armed = undefined
    try {
      const head = this.queue.shift()
      if (!head) return
      head.run()
      // Tasks sharing the head's due time, and any already overdue, run in the
      // same turn — always from the head, so (due, seq) order is preserved.
      const now = Date.now()
      while (this.queue.length > 0 && (this.queue[0].due <= head.due || this.queue[0].due <= now)) this.queue.shift()!.run()
    } finally {
      this.arm()
    }
  }
}

interface ResolvedOptions {
  duplicates: { probability: number; copies: number; delay: ChaosDelay } | null
  reorder: { window: number; maxHoldMs: number; strategy: 'shuffle' | 'reverse' } | null
  latency: ChaosDelay
  sendLatency: ChaosDelay
  sendFailures: {
    probability: number
    attempts: Set<number>
    errors: Array<ChaosSendErrorKind | ChaosErrorFactory>
    retryAfterMs: number
    maxConsecutive: number
  } | null
  disconnects: {
    afterInbound: Set<number>
    probability: number
    downtimeMs: number
    reason: DisconnectReason
    failSendsWhileDown: boolean
    holdInboundWhileDown: boolean
    replayOnReconnect: number
  }
  aliases: {
    map: Map<UserId, UserId[]>
    strategy: 'random' | 'cycle'
    probability: number
    resolve?: (wireId: UserId) => UserId
  } | null
  kinds: Set<EventKind>
}

/**
 * An `IProvider` that wraps another one and delivers its traffic adversarially
 * (see the module docs and {@link ChaosOptions}). Pass it to `new Bot({ provider })`
 * and keep driving the wrapped provider (`chaos.inner.incoming(...)`).
 *
 * Optional provider capabilities (`typing`, `markRead`, `downloadMedia`, …)
 * are exposed only when the wrapped provider has them, so feature detection
 * in the Bot keeps working.
 */
export class ChaosProvider<P extends IProvider = IProvider> implements IProvider {
  /** The wrapped provider (drive it to simulate inbound traffic). */
  readonly inner: P
  /** Same id as the wrapped provider (store namespaces stay unchanged). */
  readonly id: string
  /** Same capabilities object as the wrapped provider. */
  readonly capabilities: ProviderCapabilities
  /** Seed in use. */
  readonly seed: number
  /** Everything the kit injected, in order. */
  readonly log: ChaosLogEntry[] = []
  /** Every inbound event actually delivered to listeners (copies and replays included), in delivery order. */
  readonly delivered: InboundEvent[] = []

  ingest?: IProvider['ingest']
  downloadMedia?: IProvider['downloadMedia']
  serializeMediaRef?: IProvider['serializeMediaRef']
  rehydrateMediaRef?: IProvider['rehydrateMediaRef']
  getMessage?: IProvider['getMessage']
  markRead?: IProvider['markRead']
  typing?: IProvider['typing']
  deleteMessage?: IProvider['deleteMessage']
  editMessage?: IProvider['editMessage']
  sendDraft?: IProvider['sendDraft']
  acknowledgeInteraction?: IProvider['acknowledgeInteraction']
  canRenderForm?: IProvider['canRenderForm']
  textFormatFor?: IProvider['textFormatFor']

  private readonly opts: ResolvedOptions
  private readonly rngInbound: () => number
  private readonly rngOutbound: () => number
  private readonly rngConnection: () => number
  private readonly rngIdentity: () => number
  private readonly listeners = new Set<InboundListener>()
  private readonly scheduler = new OrderedScheduler()
  private readonly aliasCounters = new Map<UserId, number>()
  private buffer: InboundEvent[] = []
  private bufferTimer: ScheduledTask | undefined
  private reconnectTimer: ScheduledTask | undefined
  private held: InboundEvent[] = []
  private down = false
  private attempts = 0
  private failures = 0
  private consecutiveFailures = 0
  private inboundCount = 0
  private pendingSends = 0

  /** @throws {RangeError} when an option is out of range. */
  constructor(inner: P, options: ChaosOptions = {}) {
    const seed = options.seed ?? 1
    if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new RangeError(`chaos.seed must be a finite number, got ${String(seed)}`)
    this.inner = inner
    this.id = inner.id
    this.capabilities = inner.capabilities
    this.seed = seed
    this.opts = resolveOptions(options)
    this.rngInbound = createSeededRandom(seed)
    this.rngOutbound = createSeededRandom(seed ^ 0x5bd1e995)
    this.rngConnection = createSeededRandom(seed ^ 0x27d4eb2f)
    this.rngIdentity = createSeededRandom(seed ^ 0x165667b1)

    if (inner.ingest) this.ingest = inner.ingest.bind(inner)
    if (inner.downloadMedia) this.downloadMedia = inner.downloadMedia.bind(inner)
    if (inner.serializeMediaRef) this.serializeMediaRef = inner.serializeMediaRef.bind(inner)
    if (inner.rehydrateMediaRef) this.rehydrateMediaRef = inner.rehydrateMediaRef.bind(inner)
    if (inner.getMessage) this.getMessage = inner.getMessage.bind(inner)
    if (inner.markRead) this.markRead = inner.markRead.bind(inner)
    if (inner.typing) this.typing = inner.typing.bind(inner)
    if (inner.deleteMessage) this.deleteMessage = inner.deleteMessage.bind(inner)
    if (inner.editMessage) this.editMessage = inner.editMessage.bind(inner)
    if (inner.sendDraft) this.sendDraft = inner.sendDraft.bind(inner)
    if (inner.acknowledgeInteraction) this.acknowledgeInteraction = inner.acknowledgeInteraction.bind(inner)
    if (inner.canRenderForm) this.canRenderForm = inner.canRenderForm.bind(inner)
    if (inner.textFormatFor) this.textFormatFor = inner.textFormatFor.bind(inner)

    inner.onEvent((event) => this.receive(event))
  }

  /** The wrapped provider's self id. */
  get selfId(): UserId | null | undefined { return this.inner.selfId }
  /** The wrapped provider's debug connection handle. */
  get connection(): unknown { return this.inner.connection }
  /** `false` while a simulated drop is in effect. */
  get connected(): boolean { return !this.down }
  /** Number of `send()` calls so far (failed ones included). */
  get sendAttempts(): number { return this.attempts }
  /** Scheduled deliveries, reorder/reconnect timers and delayed sends still outstanding. */
  get pending(): number { return this.scheduler.size + this.pendingSends }

  async start(): Promise<void> { await this.inner.start() }

  /** Cancels every pending delivery, buffered or held event, then stops the wrapped provider. */
  async stop(): Promise<void> {
    this.scheduler.clear()
    this.bufferTimer = undefined
    this.reconnectTimer = undefined
    this.buffer = []
    this.held = []
    this.down = false
    await this.inner.stop()
  }

  onEvent(listener: InboundListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Send through the wrapped provider unless chaos decides this attempt fails
   * (scripted `attempts`, `probability`, or the connection is down), in which
   * case it rejects with a typed `ProviderError` and nothing reaches the
   * wrapped provider's outbox.
   */
  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    const attempt: ChaosSendAttempt = { attempt: ++this.attempts, chatId, content, options }
    let failure = this.drawSendFailure(attempt)
    const delay = drawDelay(this.opts.sendLatency, this.rngOutbound)
    if (delay > 0) await this.sleep(delay)
    if (!failure && this.down && this.opts.disconnects.failSendsWhileDown) failure = new ChaosDisconnectedError(chatId)
    if (failure) {
      this.log.push({ type: 'send-failure', attempt: attempt.attempt, chatId, error: failure.name })
      throw failure
    }
    return this.inner.send(chatId, content, options)
  }

  /**
   * Simulate a connection drop: emits `{ state: 'closed', reason }`, then holds
   * inbound and fails sends (per options) until {@link reconnect}. A finite
   * `downtimeMs` schedules the reconnect automatically; the default for a
   * manual drop is to stay down until `reconnect()` is called.
   */
  disconnect(options: { reason?: DisconnectReason; downtimeMs?: number; retryAfterMs?: number } = {}): void {
    if (this.down) return
    this.down = true
    const reason = options.reason ?? this.opts.disconnects.reason
    const downtime = options.downtimeMs ?? Infinity
    const update: ConnectionUpdate = { state: 'closed', reason }
    if (reason === 'rateLimited') {
      const retryAfterMs = options.retryAfterMs ?? (Number.isFinite(downtime) ? downtime : undefined)
      if (retryAfterMs !== undefined) update.retryAfterMs = retryAfterMs
    }
    this.log.push({ type: 'disconnect', reason })
    this.emit({ kind: 'connection', update })
    if (Number.isFinite(downtime)) {
      this.reconnectTimer = this.timer(Math.max(0, downtime), () => {
        this.reconnectTimer = undefined
        this.reconnect()
      })
    }
  }

  /**
   * End a simulated drop: emits `connecting` then `ready`, redelivers the last
   * `replayOnReconnect` events (offline-sync duplicates), then delivers what
   * was held while down, in arrival order.
   */
  reconnect(): void {
    if (!this.down) return
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.down = false
    this.log.push({ type: 'reconnect' })
    this.emit({ kind: 'connection', update: { state: 'connecting' } })
    this.emit({ kind: 'connection', update: { state: 'ready' } })
    const n = this.opts.disconnects.replayOnReconnect
    const replay = n > 0 ? this.delivered.slice(-n) : []
    const held = this.held.splice(0)
    if (replay.length > 0) {
      this.log.push({ type: 'replay', count: replay.length })
      for (const e of replay) this.deliver(cloneInboundEvent(e))
    }
    for (const e of held) this.deliver(e)
  }

  /** Redeliver (fresh copies of) the last `count` delivered inbound events — an explicit webhook retry. */
  replay(count = 1): void {
    if (!(count > 0)) return // note: slice(-0) would select everything
    const events = this.delivered.slice(-Math.floor(count))
    if (events.length === 0) return
    this.log.push({ type: 'replay', count: events.length })
    for (const e of events) this.deliver(cloneInboundEvent(e))
  }

  /** Deliver whatever sits in the reorder window right now (permuted as configured). */
  flush(): void {
    if (this.bufferTimer) this.clearTimer(this.bufferTimer)
    this.bufferTimer = undefined
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    const order = this.permutation(batch.length)
    if (order.some((v, i) => v !== i)) this.log.push({ type: 'reorder', size: batch.length, order })
    for (const i of order) this.release(batch[i])
  }

  /**
   * Wait (real timers) until no chaos delivery, reorder flush, scheduled
   * reconnect or delayed send is pending, plus one macrotask so listeners can
   * dispatch. Events held by an indefinite drop do not count as pending.
   *
   * @throws {TimeoutError} if still busy after `timeoutMs` (default 5000).
   */
  async settle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    await macrotask()
    while (this.pending > 0) {
      if (Date.now() > deadline) throw new TimeoutError(`ChaosProvider.settle(): ${this.pending} still pending after ${timeoutMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await macrotask()
  }

  /* --------------------------------------------------------------------- */

  /** Stage 1 (arrival): alias flip, then the reorder window (or straight to release). */
  private receive(event: InboundEvent): void {
    if (event.kind === 'connection' || !this.opts.kinds.has(event.kind)) {
      this.emit(event)
      return
    }
    const e = this.applyAlias(event)
    const r = this.opts.reorder
    if (!r) {
      this.release(e)
      return
    }
    this.buffer.push(e)
    if (this.buffer.length >= r.window) {
      this.flush()
      return
    }
    if (!this.bufferTimer) {
      this.bufferTimer = this.timer(r.maxHoldMs, () => {
        this.bufferTimer = undefined
        this.flush()
      })
    }
  }

  /**
   * Stage 2 (release): duplicate copies and latency. All timing draws happen
   * here, synchronously, so the resulting interleaving is reproducible.
   */
  private release(e: InboundEvent): void {
    const dup = this.opts.duplicates
    const copies = dup && dup.probability > 0 && this.rngInbound() < dup.probability ? dup.copies : 0
    const base = drawDelay(this.opts.latency, this.rngInbound)
    if (base > 0) this.log.push({ type: 'latency', ms: base })
    this.after(base, () => this.deliver(e))
    if (copies > 0 && dup) {
      this.log.push({ type: 'duplicate', ref: describeEvent(e), copies })
      for (let c = 0; c < copies; c++) {
        const copy = cloneInboundEvent(e)
        this.after(base + drawDelay(dup.delay, this.rngInbound), () => this.deliver(copy))
      }
    }
  }

  private deliver(event: InboundEvent): void {
    const d = this.opts.disconnects
    if (this.down && d.holdInboundWhileDown) {
      this.held.push(event)
      this.log.push({ type: 'hold', held: this.held.length })
      return
    }
    this.delivered.push(event)
    this.emit(event)
    this.inboundCount++
    if (!this.down && (d.afterInbound.has(this.inboundCount) || (d.probability > 0 && this.rngConnection() < d.probability))) {
      this.disconnect({ downtimeMs: d.downtimeMs })
    }
  }

  private applyAlias(event: InboundEvent): InboundEvent {
    const a = this.opts.aliases
    if (!a || (event.kind !== 'message' && event.kind !== 'interaction')) return event
    const canonical = event.kind === 'message' ? event.message.senderId : event.interaction.senderId
    const aliases = a.map.get(canonical)
    if (!aliases || aliases.length === 0) return event
    let wire = canonical
    if (a.strategy === 'cycle') {
      const n = this.aliasCounters.get(canonical) ?? 0
      this.aliasCounters.set(canonical, n + 1)
      const pool = [canonical, ...aliases]
      wire = pool[n % pool.length]
    } else if (a.probability > 0 && this.rngIdentity() < a.probability) {
      wire = aliases[Math.floor(this.rngIdentity() * aliases.length)]
    }
    const emitted = a.resolve ? a.resolve(wire) : wire
    if (wire !== canonical || emitted !== canonical) this.log.push({ type: 'alias', canonical, wire, emitted })
    return emitted === canonical ? event : rewriteIdentity(event, canonical, emitted)
  }

  private drawSendFailure(a: ChaosSendAttempt): Error | undefined {
    if (this.down && this.opts.disconnects.failSendsWhileDown) return new ChaosDisconnectedError(a.chatId)
    const f = this.opts.sendFailures
    if (!f) return undefined
    let fail = f.attempts.has(a.attempt)
    if (!fail && f.probability > 0 && this.consecutiveFailures < f.maxConsecutive) {
      fail = this.rngOutbound() < f.probability
    }
    if (!fail) {
      this.consecutiveFailures = 0
      return undefined
    }
    this.consecutiveFailures++
    const spec = f.errors[this.failures++ % f.errors.length]
    return typeof spec === 'function' ? spec(a) : errorFor(spec, a, f.retryAfterMs)
  }

  private permutation(n: number): number[] {
    const order = Array.from({ length: n }, (_, i) => i)
    if (this.opts.reorder?.strategy === 'reverse') return order.reverse()
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.rngInbound() * (i + 1))
      const tmp = order[i]
      order[i] = order[j]
      order[j] = tmp
    }
    return order
  }

  private emit(event: InboundEvent): void {
    for (const listener of this.listeners) {
      // Fire-and-forget like real transports, without leaking rejected async
      // listeners as process-level unhandled rejections.
      try { void Promise.resolve(listener(event)).catch(() => undefined) }
      catch { /* a throwing listener must not stop delivery to the others */ }
    }
  }

  private after(ms: number, fn: () => void): void {
    if (ms <= 0) fn()
    else this.scheduler.schedule(ms, fn)
  }

  private timer(ms: number, fn: () => void): ScheduledTask {
    return this.scheduler.schedule(ms, fn)
  }

  private clearTimer(task: ScheduledTask): void {
    this.scheduler.cancel(task)
  }

  private sleep(ms: number): Promise<void> {
    this.pendingSends++
    return new Promise((resolve) => setTimeout(() => {
      this.pendingSends--
      resolve()
    }, ms))
  }
}

/**
 * Wrap `provider` in a {@link ChaosProvider}.
 *
 * @example
 * ```ts
 * const mock = new MockProvider()
 * const chaos = withChaos(mock, { seed: 3, duplicates: 1 })
 * const bot = new Bot({ provider: chaos })
 * mock.incoming('hola') // delivered twice; the Bot's inbound dedupe drops the copy
 * ```
 */
export function withChaos<P extends IProvider>(provider: P, options: ChaosOptions = {}): ChaosProvider<P> {
  return new ChaosProvider(provider, options)
}

/**
 * Structural copy of a normalized inbound event (fresh `ref`/`chat`/`senderInfo`
 * objects; `raw` and `media` shared) — what a re-parsed webhook body looks like.
 */
export function cloneInboundEvent(event: InboundEvent): InboundEvent {
  switch (event.kind) {
    case 'message': {
      const m = event.message
      return {
        kind: 'message',
        message: {
          ...m,
          ref: { ...m.ref },
          chat: { ...m.chat },
          senderInfo: { ...m.senderInfo },
          mentions: Array.isArray(m.mentions) ? [...m.mentions] : m.mentions,
        },
      }
    }
    case 'interaction': {
      const i = event.interaction
      return {
        kind: 'interaction',
        interaction: { ...i, ref: { ...i.ref }, chat: { ...i.chat }, senderInfo: { ...i.senderInfo } },
      }
    }
    default:
      return { ...event }
  }
}

/* ============================================================================
 * INTERNALS
 * ========================================================================== */

const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>([
  'message', 'interaction', 'status', 'reaction', 'poll-vote', 'connection', 'group', 'presence', 'call',
])
const SEND_ERROR_KINDS: ReadonlySet<string> = new Set<ChaosSendErrorKind>([
  'rate-limited', 'unreachable', 'payload-too-large', 'outside-window', 'unsupported', 'disconnected',
])
const DISCONNECT_REASONS: ReadonlySet<string> = new Set<DisconnectReason>([
  'sessionInvalid', 'sessionTakenOver', 'transient', 'rateLimited', 'unknown',
])

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function describeEvent(event: InboundEvent): string {
  if (event.kind === 'message') return `${event.message.chatId}/${event.message.ref?.id}`
  if (event.kind === 'interaction') return `${event.interaction.chatId}/${event.interaction.interactionId}`
  return event.kind
}

function drawDelay(delay: ChaosDelay, rng: () => number): number {
  if (typeof delay === 'number') return delay
  if (delay.max <= delay.min) return delay.min
  return delay.min + Math.floor(rng() * (delay.max - delay.min + 1))
}

function errorFor(kind: ChaosSendErrorKind, a: ChaosSendAttempt, retryAfterMs: number): ProviderError {
  switch (kind) {
    case 'rate-limited': return new RateLimitedError(retryAfterMs)
    case 'unreachable': return new RecipientUnreachableError(a.chatId)
    case 'payload-too-large': return new PayloadTooLargeError(`Payload too large for a ${a.content.kind} message`)
    case 'outside-window': return new OutsideSessionWindowError(a.chatId)
    case 'unsupported': return new UnsupportedContentError(a.content.kind)
    case 'disconnected': return new ChaosDisconnectedError(a.chatId)
  }
}

function rewriteIdentity(event: InboundEvent, canonical: UserId, alias: UserId): InboundEvent {
  const copy = cloneInboundEvent(event)
  const m = copy.kind === 'message' ? copy.message : copy.kind === 'interaction' ? copy.interaction : undefined
  if (!m) return copy
  m.senderId = alias
  m.sender = alias
  m.senderInfo.id = alias
  // A DM keyed by the user's own id (WhatsApp, Telegram, Meta) flips with the
  // sender; chats with their own id (groups, Discord DM channels) do not.
  if (m.chatId === canonical) {
    m.chatId = alias
    m.from = alias
    m.chat.id = alias
    if (m.ref.chatId === canonical) m.ref.chatId = alias
  }
  return copy
}

function probability(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`chaos.${name} must be a probability in [0, 1], got ${String(value)}`)
  }
  return value
}

function integer(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new RangeError(`chaos.${name} must be an integer >= ${min}, got ${String(value)}`)
  }
  return value
}

function delayOf(value: ChaosDelay | undefined, name: string): ChaosDelay {
  if (value === undefined) return 0
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (typeof value === 'number') {
    if (!ok(value)) throw new RangeError(`chaos.${name} must be a finite delay >= 0 ms, got ${String(value)}`)
    return value
  }
  if (typeof value !== 'object' || value === null || !ok(value.min) || !ok(value.max) || value.min > value.max) {
    throw new RangeError(`chaos.${name} must be a delay >= 0 or { min, max } with 0 <= min <= max`)
  }
  return { min: value.min, max: value.max }
}

function resolveOptions(o: ChaosOptions): ResolvedOptions {
  let duplicates: ResolvedOptions['duplicates'] = null
  if (o.duplicates !== undefined) {
    const d = typeof o.duplicates === 'number' ? { probability: o.duplicates } : o.duplicates
    duplicates = {
      probability: probability(d.probability ?? 1, 'duplicates.probability'),
      copies: integer(d.copies ?? 1, 'duplicates.copies', 1),
      delay: delayOf(d.delayMs, 'duplicates.delayMs'),
    }
  }

  let reorder: ResolvedOptions['reorder'] = null
  if (o.reorder !== undefined) {
    const r = typeof o.reorder === 'number' ? { window: o.reorder } : o.reorder
    const strategy = r.strategy ?? 'shuffle'
    if (strategy !== 'shuffle' && strategy !== 'reverse') throw new RangeError(`chaos.reorder.strategy must be 'shuffle' | 'reverse'`)
    const maxHoldMs = r.maxHoldMs ?? 5
    if (typeof maxHoldMs !== 'number' || !Number.isFinite(maxHoldMs) || maxHoldMs < 0) {
      throw new RangeError(`chaos.reorder.maxHoldMs must be a finite number >= 0, got ${String(maxHoldMs)}`)
    }
    reorder = { window: integer(r.window, 'reorder.window', 2), maxHoldMs, strategy }
  }

  let sendFailures: ResolvedOptions['sendFailures'] = null
  if (o.sendFailures !== undefined) {
    const s = typeof o.sendFailures === 'number' ? { probability: o.sendFailures } : o.sendFailures
    const attempts = (s.attempts ?? []).map((n, i) => integer(n, `sendFailures.attempts[${i}]`, 1))
    const errors = s.errors ?? ['rate-limited']
    if (!Array.isArray(errors) || errors.length === 0) throw new RangeError('chaos.sendFailures.errors must be a non-empty array')
    for (const e of errors) {
      if (typeof e !== 'function' && !SEND_ERROR_KINDS.has(e)) throw new RangeError(`chaos.sendFailures.errors: unknown kind '${String(e)}'`)
    }
    const maxConsecutive = s.maxConsecutive ?? Infinity
    if (maxConsecutive !== Infinity) integer(maxConsecutive, 'sendFailures.maxConsecutive', 1)
    const retryAfterMs = s.retryAfterMs ?? 1000
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError('chaos.sendFailures.retryAfterMs must be a finite number >= 0')
    }
    sendFailures = {
      probability: probability(s.probability ?? (s.attempts ? 0 : 1), 'sendFailures.probability'),
      attempts: new Set(attempts),
      errors: [...errors],
      retryAfterMs,
      maxConsecutive,
    }
  }

  const dc = o.disconnects ?? {}
  const reason = dc.reason ?? 'transient'
  if (!DISCONNECT_REASONS.has(reason)) throw new RangeError(`chaos.disconnects.reason: unknown reason '${String(reason)}'`)
  const downtimeMs = dc.downtimeMs ?? 10
  if (typeof downtimeMs !== 'number' || Number.isNaN(downtimeMs) || downtimeMs < 0) {
    throw new RangeError('chaos.disconnects.downtimeMs must be >= 0 (Infinity allowed)')
  }
  const disconnects: ResolvedOptions['disconnects'] = {
    afterInbound: new Set((dc.afterInbound ?? []).map((n, i) => integer(n, `disconnects.afterInbound[${i}]`, 1))),
    probability: probability(dc.probability ?? 0, 'disconnects.probability'),
    downtimeMs,
    reason,
    failSendsWhileDown: dc.failSendsWhileDown ?? true,
    holdInboundWhileDown: dc.holdInboundWhileDown ?? true,
    replayOnReconnect: integer(dc.replayOnReconnect ?? 0, 'disconnects.replayOnReconnect', 0),
  }

  let aliases: ResolvedOptions['aliases'] = null
  if (o.aliases !== undefined) {
    const a = o.aliases
    if (typeof a.map !== 'object' || a.map === null) throw new RangeError('chaos.aliases.map must be an object { canonicalId: aliasIds[] }')
    const map = new Map<UserId, UserId[]>()
    for (const [canonical, ids] of Object.entries(a.map)) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id === '')) {
        throw new RangeError(`chaos.aliases.map['${canonical}'] must be an array of non-empty ids`)
      }
      map.set(canonical, [...ids])
    }
    const strategy = a.strategy ?? 'random'
    if (strategy !== 'random' && strategy !== 'cycle') throw new RangeError(`chaos.aliases.strategy must be 'random' | 'cycle'`)
    if (a.resolve !== undefined && typeof a.resolve !== 'function') throw new RangeError('chaos.aliases.resolve must be a function')
    aliases = { map, strategy, probability: probability(a.probability ?? 0.5, 'aliases.probability'), resolve: a.resolve }
  }

  const kinds = new Set<EventKind>(o.kinds ?? ['message', 'interaction'])
  for (const k of kinds) {
    if (!EVENT_KINDS.has(k)) throw new RangeError(`chaos.kinds: unknown event kind '${String(k)}'`)
  }

  return {
    duplicates,
    reorder,
    latency: delayOf(o.latency, 'latency'),
    sendLatency: delayOf(o.sendLatency, 'sendLatency'),
    sendFailures,
    disconnects,
    aliases,
    kinds,
  }
}
