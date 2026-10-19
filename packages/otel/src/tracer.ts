/**
 * The {@link BotTracer} over OpenTelemetry: every bot span becomes an OTel span of the
 * configured tracer provider, nested under the active OTel context (e.g. the HTTP span
 * of a webhook), and `withSpan` makes bot spans the active OTel context so the SDK's
 * auto-instrumentations (http, undici, pg, …) nest under them.
 */
import { noopTracer, type BotSpan, type BotTracer, type SpanContextRef, type SpanException, type SpanKind, type SpanOptions, type SpanStatus, type TraceAttributeValue, type TraceAttributes } from '@bot-wa/core'
import type { Attributes, Context, Link, MeterProvider, Span, TracerProvider } from '@opentelemetry/api'

import { loadOtelApi, type OtelApi } from './load.js'
import { METRIC_SOURCE_KEYS, SpanMetrics } from './spanMetrics.js'

/** Options of {@link createOtelTracer} / {@link otelTracer} / {@link lazyOtelTracer}. */
export interface OtelTracingOptions {
  /** The `@opentelemetry/api` module; injected, the tracer is built synchronously (tests, bundlers). */
  api?: OtelApi
  /** Default: the global one (`api.trace.getTracerProvider()`, set by the SDK). */
  tracerProvider?: TracerProvider
  /** Instrumentation scope name. Default `'@bot-wa/otel'`. */
  tracerName?: string
  /**
   * Derive latency/token histograms from finished spans (low-cardinality attributes
   * only; see {@link SpanMetrics}). Default `true` (on the global meter provider);
   * `false` turns it off. Recorded whether or not the span was sampled.
   */
  spanMetrics?: boolean | { meterProvider?: MeterProvider; prefix?: string }
}


function toAttributes(attrs: TraceAttributes | undefined): Attributes | undefined {
  if (!attrs) return undefined
  const out: Attributes = {}
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v as Attributes[string]
  return out
}

/** One bot span backed by an OTel span. */
class OtelBotSpan implements BotSpan {
  private readonly started = performance.now()
  /** Attributes {@link SpanMetrics} reads (only when span metrics are on). */
  private readonly picked?: Map<string, TraceAttributeValue>

  constructor(
    readonly otel: Span,
    private readonly api: OtelApi,
    private readonly name: string,
    private readonly metrics?: SpanMetrics,
    initial?: TraceAttributes,
  ) {
    if (metrics) {
      this.picked = new Map()
      if (initial) this.pick(initial)
    }
  }

  private pick(attrs: TraceAttributes): void {
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && METRIC_SOURCE_KEYS.has(k)) this.picked!.set(k, v)
  }

  setAttribute(key: string, value: TraceAttributeValue | undefined): this {
    if (value === undefined) return this
    this.otel.setAttribute(key, value as Attributes[string] & {})
    if (this.picked && METRIC_SOURCE_KEYS.has(key)) this.picked.set(key, value)
    return this
  }
  setAttributes(attrs: TraceAttributes): this {
    const a = toAttributes(attrs)
    if (a) this.otel.setAttributes(a)
    if (this.picked) this.pick(attrs)
    return this
  }
  addEvent(name: string, attrs?: TraceAttributes): this {
    this.otel.addEvent(name, toAttributes(attrs))
    return this
  }
  recordException(error: SpanException): this {
    this.otel.recordException({ name: error.name, ...(error.message !== undefined ? { message: error.message } : {}), ...(error.code !== undefined ? { code: error.code } : {}) })
    return this
  }
  setStatus(status: SpanStatus): this {
    const code = status.code === 'error' ? this.api.SpanStatusCode.ERROR : status.code === 'ok' ? this.api.SpanStatusCode.OK : this.api.SpanStatusCode.UNSET
    this.otel.setStatus({ code, ...(status.message !== undefined ? { message: status.message } : {}) })
    return this
  }
  end(endTimeMs?: number): void {
    this.otel.end(endTimeMs)
    if (this.metrics && this.picked) {
      try { this.metrics.record(this.name, performance.now() - this.started, this.picked) } catch { /* metrics never break a span */ }
    }
  }
  isRecording(): boolean { return this.otel.isRecording() }
  spanContext(): SpanContextRef | undefined {
    const c = this.otel.spanContext()
    const traceState = c.traceState?.serialize()
    return { traceId: c.traceId, spanId: c.spanId, traceFlags: c.traceFlags, ...(traceState ? { traceState } : {}) }
  }
}

/** Build the tracer from a loaded `@opentelemetry/api` (synchronous). */
export function otelTracer(opts: OtelTracingOptions & { api: OtelApi }): BotTracer {
  const { api } = opts
  const provider = opts.tracerProvider ?? api.trace.getTracerProvider()
  const tracer = provider.getTracer(opts.tracerName ?? '@bot-wa/otel')
  const sm = opts.spanMetrics ?? true
  const metrics = sm === false
    ? undefined
    : new SpanMetrics((typeof sm === 'object' && sm.meterProvider) || api.metrics.getMeterProvider(), opts.tracerName ?? '@bot-wa/otel', (typeof sm === 'object' && sm.prefix) || 'botwa')

  const kinds: Record<SpanKind, OtelApi['SpanKind'][keyof OtelApi['SpanKind']]> = {
    internal: api.SpanKind.INTERNAL, server: api.SpanKind.SERVER, client: api.SpanKind.CLIENT,
    producer: api.SpanKind.PRODUCER, consumer: api.SpanKind.CONSUMER,
  }
  const parentContext = (parent: SpanOptions['parent']): Context => {
    if (parent === null) return api.ROOT_CONTEXT
    if (parent instanceof OtelBotSpan) return api.trace.setSpan(api.context.active(), parent.otel)
    return api.context.active()
  }

  return {
    startSpan(name: string, options: SpanOptions = {}): BotSpan {
      const links: Link[] | undefined = options.links?.map((l) => ({
        context: {
          traceId: l.context.traceId,
          spanId: l.context.spanId,
          traceFlags: l.context.traceFlags ?? 1,
          // A context carried from another process (a resumed checkpoint) is remote.
          isRemote: l.context.isRemote === true,
          ...(l.context.traceState ? { traceState: api.createTraceState(l.context.traceState) } : {}),
        },
        ...(l.attributes ? { attributes: toAttributes(l.attributes) } : {}),
      }))
      const span = tracer.startSpan(name, {
        kind: kinds[options.kind ?? 'internal'],
        ...(options.attributes ? { attributes: toAttributes(options.attributes) } : {}),
        ...(links?.length ? { links } : {}),
        ...(options.startTimeMs !== undefined ? { startTime: options.startTimeMs } : {}),
      }, parentContext(options.parent))
      return new OtelBotSpan(span, api, name, metrics, options.attributes)
    },
    withSpan<T>(span: BotSpan, fn: () => T): T {
      if (!(span instanceof OtelBotSpan)) return fn()
      return api.context.with(api.trace.setSpan(api.context.active(), span.otel), fn)
    },
  }
}

/** Load `@opentelemetry/api` (unless injected) and build the tracer. Rejects with an install hint when it is missing. */
export async function createOtelTracer(opts: OtelTracingOptions = {}): Promise<BotTracer> {
  const api = opts.api ?? (await loadOtelApi())
  return otelTracer({ ...opts, api })
}

/** A {@link lazyOtelTracer}: usable at once; `ready` settles when OpenTelemetry is loaded. */
export interface LazyOtelTracer extends BotTracer {
  /** Resolves once the real tracer is in place; rejects (install hint) when `@opentelemetry/api` is missing. */
  readonly ready: Promise<void>
}

/**
 * A tracer usable synchronously (e.g. in a `new Bot({...})` built at import time):
 * spans are no-ops until `@opentelemetry/api` is loaded, then go to OpenTelemetry. A
 * load failure never throws into the bot: it rejects `ready` (log it from there).
 * `load` is a test seam.
 */
export function lazyOtelTracer(opts: OtelTracingOptions = {}, load?: () => Promise<unknown>): LazyOtelTracer {
  let real: BotTracer | undefined
  const ready = (opts.api ? Promise.resolve(opts.api) : loadOtelApi(load)).then((api) => { real = otelTracer({ ...opts, api }) })
  ready.catch(() => {})   // reported through `ready`; never an unhandled rejection
  return {
    ready,
    startSpan: (name, options) => (real ?? noopTracer).startSpan(name, options),
    withSpan: <T>(span: BotSpan, fn: () => T): T => (real?.withSpan ? real.withSpan(span, fn) : fn()),
  }
}
