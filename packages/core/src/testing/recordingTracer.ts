/**
 * An in-memory {@link BotTracer} for tests: records every span (name, kind, parent,
 * attributes, events, status, links, exceptions, order) so a test can assert on the
 * span tree a bot produced without any tracing SDK.
 *
 * @example
 * ```ts
 * const rec = createRecordingTracer()
 * const { bot, chat } = await createTestBot({ telemetry: { tracer: rec.tracer, ids: 'raw' } })
 * bot.when('hola', (ctx) => ctx.reply('hi'))
 * await chat.send('hola')
 * const send = rec.find('bot.send')!
 * expect(rec.parentOf(send)?.name).toBe('bot.handler')
 * ```
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type {
  BotSpan, BotTracer, SpanContextRef, SpanException, SpanKind, SpanLink, SpanOptions, SpanStatus,
  TraceAttributeValue, TraceAttributes,
} from '../telemetry/types.js'

/** One recorded span. */
export interface RecordedSpan {
  readonly name: string
  readonly kind: SpanKind
  readonly traceId: string
  readonly spanId: string
  /** `spanId` of the parent; `undefined` for a root span. */
  readonly parentId?: string
  readonly attributes: Record<string, TraceAttributeValue>
  readonly events: Array<{ name: string; attributes?: TraceAttributes }>
  readonly exceptions: SpanException[]
  readonly links: SpanLink[]
  status: SpanStatus
  /** Order of `startSpan` calls (0-based). */
  readonly startOrder: number
  /** Order of `end` calls; `undefined` while the span is open. */
  endOrder?: number
  readonly ended: boolean
}

/** Options of {@link createRecordingTracer}. */
export interface RecordingTracerOptions {
  /** `false` makes every span non-recording (`isRecording() === false`), like a sampler dropping it. Default true. */
  sampled?: boolean
  /** Implement `withSpan` (the backend-context bridge). Default true. */
  withSpan?: boolean
}

/** What {@link createRecordingTracer} returns. */
export interface RecordingTracer {
  readonly tracer: BotTracer
  /** Every span started so far, in start order. */
  readonly spans: RecordedSpan[]
  /** First span named `name` (matching `pred` when given). */
  find(name: string, pred?: (span: RecordedSpan) => boolean): RecordedSpan | undefined
  /** Every span named `name`. */
  findAll(name: string): RecordedSpan[]
  parentOf(span: RecordedSpan): RecordedSpan | undefined
  childrenOf(span: RecordedSpan): RecordedSpan[]
  /** Every attribute value and event attribute value as strings (for "no PII" scans). */
  allValues(): string[]
  reset(): void
}

class RecSpan implements BotSpan {
  constructor(readonly rec: RecordedSpan & { ended: boolean }, private readonly sampled: boolean, private readonly nextEnd: () => number) {}
  setAttribute(key: string, value: TraceAttributeValue | undefined): this {
    if (value !== undefined) this.rec.attributes[key] = value
    return this
  }
  setAttributes(attrs: TraceAttributes): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v)
    return this
  }
  addEvent(name: string, attributes?: TraceAttributes): this {
    this.rec.events.push(attributes ? { name, attributes } : { name })
    return this
  }
  recordException(error: SpanException): this {
    this.rec.exceptions.push(error)
    return this
  }
  setStatus(status: SpanStatus): this {
    this.rec.status = status
    return this
  }
  end(): void {
    if (this.rec.ended) return
    this.rec.ended = true
    this.rec.endOrder = this.nextEnd()
  }
  isRecording(): boolean { return this.sampled && !this.rec.ended }
  spanContext(): SpanContextRef { return { traceId: this.rec.traceId, spanId: this.rec.spanId } }
}

/** Create an in-memory tracer for tests (see {@link RecordingTracer}). */
export function createRecordingTracer(options: RecordingTracerOptions = {}): RecordingTracer {
  const sampled = options.sampled !== false
  const spans: RecordedSpan[] = []
  const als = new AsyncLocalStorage<RecSpan>()
  let ids = 0
  let ends = 0
  const nextEnd = (): number => ends++
  const tracer: BotTracer = {
    startSpan(name: string, opts: SpanOptions = {}): BotSpan {
      const parent = opts.parent === null
        ? undefined
        : opts.parent instanceof RecSpan ? opts.parent : als.getStore()
      const spanId = `s${++ids}`
      const rec: RecordedSpan & { ended: boolean } = {
        name,
        kind: opts.kind ?? 'internal',
        traceId: parent?.rec.traceId ?? `t${spanId}`,
        spanId,
        ...(parent ? { parentId: parent.rec.spanId } : {}),
        attributes: {},
        events: [],
        exceptions: [],
        links: opts.links ? [...opts.links] : [],
        status: { code: 'unset' },
        startOrder: spans.length,
        ended: false,
      }
      spans.push(rec)
      const span = new RecSpan(rec, sampled, nextEnd)
      if (opts.attributes) span.setAttributes(opts.attributes)
      return span
    },
    ...(options.withSpan === false
      ? {}
      : { withSpan: <T>(span: BotSpan, fn: () => T): T => (span instanceof RecSpan ? als.run(span, fn) : fn()) }),
  }
  const byId = (id: string | undefined) => (id === undefined ? undefined : spans.find((s) => s.spanId === id))
  return {
    tracer,
    spans,
    find: (name, pred) => spans.find((s) => s.name === name && (!pred || pred(s))),
    findAll: (name) => spans.filter((s) => s.name === name),
    parentOf: (span) => byId(span.parentId),
    childrenOf: (span) => spans.filter((s) => s.parentId === span.spanId),
    allValues: () => spans.flatMap((s) => [
      ...Object.values(s.attributes).flatMap((v) => (Array.isArray(v) ? v.map(String) : [String(v)])),
      ...s.events.flatMap((e) => Object.values(e.attributes ?? {}).map(String)),
      ...s.exceptions.flatMap((e) => [e.name, e.message ?? '']),
      s.status.message ?? '',
    ]),
    reset: () => { spans.length = 0 },
  }
}
