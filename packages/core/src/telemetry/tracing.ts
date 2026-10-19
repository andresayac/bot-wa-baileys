/**
 * The bot's tracing implementation (`BotConfig.telemetry`): a fault-isolating wrapper
 * around the user's {@link BotTracer} plus the {@link BotTracing} facade the pipeline
 * modules, `bot.tracing` and plugins use.
 *
 * {@link createTracing} returns `null` when telemetry is not configured; every
 * instrumentation site checks that first (`if (!k.tracing) return original()`), so an
 * unconfigured bot runs exactly the code it ran before — no ALS, no extra awaits.
 *
 * Telemetry can never fail or reorder message handling: every call into the user's
 * tracer is guarded (a throw falls back to a no-op span and logs a rate-limited warning),
 * and {@link TracingImpl.trace} returns `fn`'s own promise, ending the span on a side
 * branch.
 */
import type { Logger } from 'pino'

import { activeBox, enterBox, type TraceBox } from './context.js'
import { createIdPolicy, type IdPolicy } from './ids.js'
import { TRACE_ATTR } from './attributes.js'
import type {
  BotSpan, BotTracer, BotTracing, SpanContextRef, SpanException, SpanOptions, SpanStatus, TelemetryConfig,
  TraceAttributeValue, TraceAttributes,
} from './types.js'

/** A span that records nothing (sampled out, tracing off, or a tracer that failed). */
class NoopSpan implements BotSpan {
  setAttribute(): this { return this }
  setAttributes(): this { return this }
  addEvent(): this { return this }
  recordException(): this { return this }
  setStatus(): this { return this }
  end(): void {}
  isRecording(): boolean { return false }
  spanContext(): SpanContextRef | undefined { return undefined }
}

/** The shared no-op span. */
export const NOOP_SPAN: BotSpan = Object.freeze(new NoopSpan())

/** A tracer that records nothing (every span is a shared, frozen no-op span). */
export const noopTracer: BotTracer = Object.freeze({ startSpan: (): BotSpan => NOOP_SPAN })

/** `bot.tracing` of a bot without `BotConfig.telemetry`: disabled, every call a no-op. */
export const NOOP_TRACING: BotTracing = Object.freeze({
  enabled: false,
  startSpan: (): BotSpan => NOOP_SPAN,
  activeSpan: (): BotSpan | undefined => undefined,
  withSpan: <T>(_span: BotSpan, fn: () => T): T => fn(),
  trace: <T>(_name: string, _options: SpanOptions, fn: (span: BotSpan) => T): T => fn(NOOP_SPAN),
  recordError: (): void => {},
  idAttribute: (): string | undefined => undefined,
})

const WARN_EVERY_MS = 60_000

/** Reports tracer failures at `warn`, at most once per minute. */
class Guard {
  private lastWarn = -Infinity
  constructor(private readonly logger: Pick<Logger, 'warn'>) {}
  failed(op: string, error: unknown): void {
    const now = Date.now()
    if (now - this.lastWarn < WARN_EVERY_MS) return
    this.lastWarn = now
    try {
      this.logger.warn({ op, err: error instanceof Error ? error.name : typeof error }, 'tracer call failed (telemetry ignored)')
    } catch { /* a logger must not break the bot either */ }
  }
}

/** Fault-isolating wrapper over a span of the user's tracer; ending twice is a no-op. */
class SafeSpan implements BotSpan {
  private ended = false
  constructor(readonly inner: BotSpan, private readonly guard: Guard) {}
  private run(op: string, fn: () => void): void {
    try { fn() } catch (error) { this.guard.failed(op, error) }
  }
  setAttribute(key: string, value: TraceAttributeValue | undefined): this {
    if (value !== undefined) this.run('setAttribute', () => { this.inner.setAttribute(key, value) })
    return this
  }
  setAttributes(attrs: TraceAttributes): this {
    const clean = defined(attrs)
    if (clean) this.run('setAttributes', () => { this.inner.setAttributes(clean) })
    return this
  }
  addEvent(name: string, attrs?: TraceAttributes): this {
    this.run('addEvent', () => { this.inner.addEvent(name, attrs ? defined(attrs) : undefined) })
    return this
  }
  recordException(error: SpanException): this {
    this.run('recordException', () => { this.inner.recordException(error) })
    return this
  }
  setStatus(status: SpanStatus): this {
    this.run('setStatus', () => { this.inner.setStatus(status) })
    return this
  }
  end(endTimeMs?: number): void {
    if (this.ended) return
    this.ended = true
    this.run('end', () => { this.inner.end(endTimeMs) })
  }
  isRecording(): boolean {
    try { return this.inner.isRecording() } catch (error) { this.guard.failed('isRecording', error); return false }
  }
  spanContext(): SpanContextRef | undefined {
    try { return this.inner.spanContext() } catch (error) { this.guard.failed('spanContext', error); return undefined }
  }
}

/** `attrs` without its `undefined` entries (or `undefined` when nothing is left). */
function defined(attrs: TraceAttributes): TraceAttributes | undefined {
  let out: TraceAttributes | undefined
  for (const key of Object.keys(attrs)) {
    const value = attrs[key]
    if (value === undefined) continue
    ;(out ??= {})[key] = value
  }
  return out
}

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return typeof (x as { then?: unknown } | null | undefined)?.then === 'function'
}

/** Name of an error for `error.type` (class name), never its message. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name || 'Error'
  if (error === null) return 'null'
  return typeof error
}

/** Ids of one message, written through the `ids` policy. */
export interface TraceIds {
  chatId?: string
  senderId?: string
  messageId?: string
}

/** The configured tracing of one bot (`BotKernel.tracing`). */
export class TracingImpl implements BotTracing {
  readonly enabled = true
  /** `spans.persist` (default true). */
  readonly persistSpans: boolean
  /** `spans.pace` (default true). */
  readonly paceSpans: boolean
  /** `spans.streamUpdates` (default false). */
  readonly streamSpans: boolean
  private readonly guard: Guard
  private readonly ids: IdPolicy
  private readonly errorMessages: boolean

  constructor(private readonly tracer: BotTracer, cfg: TelemetryConfig, logger: Pick<Logger, 'warn'>) {
    this.guard = new Guard(logger)
    this.ids = createIdPolicy(cfg)
    this.errorMessages = cfg.errorMessages === true
    this.persistSpans = cfg.spans?.persist !== false
    this.paceSpans = cfg.spans?.pace !== false
    this.streamSpans = cfg.spans?.streamUpdates === true
  }

  startSpan(name: string, options: SpanOptions = {}): BotSpan {
    const parent = options.parent === undefined ? activeBox()?.span : options.parent
    const opts: SpanOptions = { ...options }
    if (parent === null) opts.parent = null
    else if (parent === undefined || parent === NOOP_SPAN) delete opts.parent
    else opts.parent = parent instanceof SafeSpan ? parent.inner : parent
    if (opts.attributes) {
      const clean = defined(opts.attributes)
      if (clean) opts.attributes = clean
      else delete opts.attributes
    }
    try {
      const span = this.tracer.startSpan(name, opts)
      return span ? new SafeSpan(span, this.guard) : NOOP_SPAN
    } catch (error) {
      this.guard.failed('startSpan', error)
      return NOOP_SPAN
    }
  }

  activeSpan(): BotSpan | undefined { return activeBox()?.span }

  withSpan<T>(span: BotSpan, fn: () => T): T {
    return this.runInBox({ span }, fn)
  }

  /** Run `fn` with `box` current (core context) and its span active in the backend's context. */
  runInBox<T>(box: TraceBox, fn: () => T): T {
    return enterBox(box, () => this.bridge(box.span, fn))
  }

  private bridge<T>(span: BotSpan, fn: () => T): T {
    const tracer = this.tracer
    const inner = span instanceof SafeSpan ? span.inner : undefined
    if (!tracer.withSpan || !inner) return fn()
    let called = false
    try {
      return tracer.withSpan<T>(inner, () => { called = true; return fn() })
    } catch (error) {
      if (called) throw error
      this.guard.failed('withSpan', error)
      return fn()
    }
  }

  /** `expected` (core only): a rejection that is not a failure (e.g. a send deferred to the outbox). */
  trace<T>(name: string, options: SpanOptions, fn: (span: BotSpan) => T, expected?: (error: unknown) => boolean): T {
    const span = this.startSpan(name, options)
    let result: T
    try {
      result = this.withSpan(span, () => fn(span))
    } catch (error) {
      this.recordError(span, error)
      span.end()
      throw error
    }
    if (isThenable(result)) {
      // Side branch: the caller gets `result` itself (no extra ticks on its await).
      result.then(() => span.end(), (error: unknown) => {
        if (!expected?.(error)) this.recordError(span, error)
        span.end()
      })
      return result
    }
    span.end()
    return result
  }

  recordError(span: BotSpan, error: unknown): void {
    const type = errorTypeOf(error)
    const message = this.errorMessages && error instanceof Error ? error.message : undefined
    const code = (error as { code?: unknown } | null)?.code
    const exception: SpanException = { name: type }
    if (message !== undefined) exception.message = message
    if (typeof code === 'string' || typeof code === 'number') exception.code = code
    span.setAttribute(TRACE_ATTR.errorType, type)
    span.recordException(exception)
    span.setStatus(message !== undefined ? { code: 'error', message } : { code: 'error' })
  }

  idAttribute(id: string): string | undefined {
    return this.ids(id)
  }

  /** Write the ids of one message on `span` (only when it records: hashing is skipped otherwise). */
  setIds(span: BotSpan, ids: TraceIds): void {
    if (!span.isRecording()) return
    span.setAttributes({
      [TRACE_ATTR.chatId]: ids.chatId !== undefined ? this.ids(ids.chatId) : undefined,
      [TRACE_ATTR.senderId]: ids.senderId !== undefined ? this.ids(ids.senderId) : undefined,
      [TRACE_ATTR.messageId]: ids.messageId ? this.ids(ids.messageId) : undefined,
    })
  }

  /** Set an attribute on the active span (no-op outside one). */
  annotate(key: string, value: TraceAttributeValue | undefined): void {
    activeBox()?.span.setAttribute(key, value)
  }

  /** An error reported on the bot's `'error'` channel: recorded on the active span. */
  reportError(error: unknown): void {
    const span = activeBox()?.span
    if (span) this.recordError(span, error)
  }
}

/** The tracing of a bot: `null` without `BotConfig.telemetry` (every site then takes its original path). */
export function createTracing(cfg: TelemetryConfig | undefined, logger: Pick<Logger, 'warn'>): TracingImpl | null {
  if (!cfg) return null
  return new TracingImpl(cfg.tracer, cfg, logger)
}
