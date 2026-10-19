/**
 * Tracing contract of the core (`BotConfig.telemetry`): the minimal {@link BotTracer}
 * an integration implements (OpenTelemetry through `@bot-wa/otel`, a test recorder, …)
 * and the {@link BotTracing} facade the bot and its plugins use (`bot.tracing`).
 *
 * Nothing here records message bodies or personal data: the core only puts ids (hashed
 * by default), kinds, stages and outcomes on spans. See `docs/guide/tracing.md`.
 */

/** Attribute values: primitives or homogeneous primitive arrays (OpenTelemetry-compatible). */
export type TraceAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[]

/** Span attributes; `undefined` entries are dropped. */
export type TraceAttributes = Record<string, TraceAttributeValue | undefined>

/** Role of a span (same values as OpenTelemetry's `SpanKind`). */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

/** Status of a finished span. */
export interface SpanStatus {
  code: 'unset' | 'ok' | 'error'
  message?: string
}

/** Opaque identity of a span (adapters fill it; the core never parses it). */
export interface SpanContextRef {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags?: number
  /** W3C `tracestate` (serialized), when the tracer reports one; carried across replicas with the ids. */
  readonly traceState?: string
  /**
   * `true` for a context that came from another process (a checkpoint resumed after a
   * hand-over or a restart, see `FlowCheckpoint.trace`). Adapters map it to their own flag.
   */
  readonly isRemote?: boolean
}

/** A causal link to another span (e.g. a conversation's later turn → its first turn). */
export interface SpanLink {
  context: SpanContextRef
  attributes?: TraceAttributes
}

/** Sanitized error recorded on a span: the message only with `telemetry.errorMessages`. */
export interface SpanException {
  name: string
  message?: string
  code?: string | number
}

/** One span, as the core drives it. */
export interface BotSpan {
  setAttribute(key: string, value: TraceAttributeValue | undefined): this
  setAttributes(attrs: TraceAttributes): this
  addEvent(name: string, attrs?: TraceAttributes): this
  /** The core passes a sanitized error (see {@link SpanException}). */
  recordException(error: SpanException): this
  setStatus(status: SpanStatus): this
  end(endTimeMs?: number): void
  /** `false` when sampled out: the core then skips computing optional attributes (id hashing). */
  isRecording(): boolean
  spanContext(): SpanContextRef | undefined
}

/** Options of {@link BotTracer.startSpan} / {@link BotTracing.startSpan}. */
export interface SpanOptions {
  kind?: SpanKind
  attributes?: TraceAttributes
  /**
   * `undefined` = the active span (the core's own context first, then the backend's);
   * `null` = force a new root span.
   */
  parent?: BotSpan | null
  links?: SpanLink[]
  startTimeMs?: number
}

/**
 * The ONLY thing a tracing integration implements. Minimal on purpose, so it can be
 * backed by OpenTelemetry (`@bot-wa/otel`), Datadog, Sentry or a test recorder.
 */
export interface BotTracer {
  startSpan(name: string, options?: SpanOptions): BotSpan
  /**
   * Optional: run `fn` with `span` active in the backend's own context too, so the
   * backend's auto-instrumentations (http, pg, undici…) nest under bot spans. Must call
   * `fn` synchronously and return its result unchanged.
   */
  withSpan?<T>(span: BotSpan, fn: () => T): T
}

/** `BotConfig.telemetry` (opt-in): where spans go and what they may contain. */
export interface TelemetryConfig {
  tracer: BotTracer
  /**
   * How chat, sender and message ids appear on spans:
   * - `'hash'` (default): HMAC-SHA256 with {@link idKey}, base64url, 16 chars;
   * - `'raw'`: the opaque id as the provider gave it (personal data on most channels);
   * - `'omit'`: not recorded.
   */
  ids?: 'hash' | 'raw' | 'omit'
  /**
   * HMAC key of `ids: 'hash'`. Default: 32 random bytes per process, so hashes do not
   * correlate across replicas or restarts — set it from a secret for that.
   */
  idKey?: string | Uint8Array
  /** Record `Error.message` on spans (it may contain user text). Default `false`: error name and code only. */
  errorMessages?: boolean
  /** Granularity toggles. Defaults: `persist` true, `pace` true, `streamUpdates` false (stream edits are span events). */
  spans?: { persist?: boolean; pace?: boolean; streamUpdates?: boolean }
}

/**
 * Tracing facade of a bot (`bot.tracing`), also used by plugins (`@bot-wa/ai`). Without
 * `BotConfig.telemetry` it is a no-op (`enabled === false`).
 */
export interface BotTracing {
  readonly enabled: boolean
  startSpan(name: string, options?: SpanOptions): BotSpan
  /** The span the current async chain runs under (core context), if any. */
  activeSpan(): BotSpan | undefined
  /** Run `fn` with `span` active (core context and the backend's). Returns `fn`'s value unchanged. */
  withSpan<T>(span: BotSpan, fn: () => T): T
  /**
   * Start a span, run `fn` inside it and end it when `fn` returns or its promise settles
   * (a throw/rejection sets status `error` and records the sanitized exception). Returns
   * `fn`'s own value or promise — never a derived one.
   */
  trace<T>(name: string, options: SpanOptions, fn: (span: BotSpan) => T): T
  /** Record a sanitized error on `span` (status `error`, `error.type`, exception event). */
  recordError(span: BotSpan, error: unknown): void
  /** Apply the `ids` policy to an id (`undefined` under `'omit'`). For plugins that tag their own spans. */
  idAttribute(id: string): string | undefined
}
