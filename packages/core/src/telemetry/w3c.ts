/**
 * W3C Trace Context (`traceparent` / `tracestate`) for span contexts the core stores
 * outside a process: a conversation checkpoint carries the context of the turn that
 * wrote it, so the replica (or the restarted process) that resumes it links its first
 * turn to the previous one (see telemetry/conversation.ts).
 *
 * Only W3C-shaped ids are carried (32/16 lowercase hex, not all zero — what OpenTelemetry
 * produces); a tracer with other ids simply carries nothing. No transport concept here.
 */
import type { SpanContextRef } from './types.js'

const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/
const INVALID_TRACE = '0'.repeat(32)
const INVALID_SPAN = '0'.repeat(16)
/** `version-traceid-spanid-flags`; versions above 00 may append `-…` fields. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/
/** W3C limit of a `tracestate` header value. */
const MAX_TRACESTATE = 512

/** A span context as stored in a checkpoint (`FlowCheckpoint.trace`). */
export interface CheckpointTrace {
  /** W3C `traceparent` of the turn that wrote the checkpoint. */
  traceparent: string
  /** W3C `tracestate` of that turn, when its tracer reports one. */
  tracestate?: string
}

/**
 * The W3C `traceparent` of `ctx` (version `00`), or `undefined` when its ids are not
 * W3C-shaped. `traceFlags` defaults to `01` (sampled).
 */
export function formatTraceparent(ctx: SpanContextRef): string | undefined {
  const { traceId, spanId } = ctx
  const flags = ctx.traceFlags ?? 1
  if (typeof traceId !== 'string' || !TRACE_ID.test(traceId) || traceId === INVALID_TRACE) return undefined
  if (typeof spanId !== 'string' || !SPAN_ID.test(spanId) || spanId === INVALID_SPAN) return undefined
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) return undefined
  return `00-${traceId}-${spanId}-${flags.toString(16).padStart(2, '0')}`
}

/**
 * Parse a W3C `traceparent` (and an optional `tracestate`) into a remote span context, or
 * `undefined` when it is malformed. A `tracestate` longer than 512 chars is dropped.
 */
export function parseTraceparent(traceparent: string, tracestate?: string): SpanContextRef | undefined {
  if (typeof traceparent !== 'string') return undefined
  const m = TRACEPARENT.exec(traceparent.trim())
  if (!m) return undefined
  const [, version, traceId, spanId, flags, rest] = m as unknown as [string, string, string, string, string, string | undefined]
  if (version === 'ff' || (version === '00' && rest !== undefined)) return undefined
  if (traceId === INVALID_TRACE || spanId === INVALID_SPAN) return undefined
  const state = typeof tracestate === 'string' ? tracestate.trim() : ''
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    ...(state && state.length <= MAX_TRACESTATE ? { traceState: state } : {}),
    isRemote: true,
  }
}

/** `ctx` as stored in a checkpoint, or `undefined` when it cannot be carried. */
export function toCheckpointTrace(ctx: SpanContextRef | undefined): CheckpointTrace | undefined {
  if (!ctx) return undefined
  const traceparent = formatTraceparent(ctx)
  if (!traceparent) return undefined
  const state = typeof ctx.traceState === 'string' ? ctx.traceState.trim() : ''
  return { traceparent, ...(state && state.length <= MAX_TRACESTATE ? { tracestate: state } : {}) }
}

/** The span context a checkpoint carries (`undefined` when absent or malformed: a store holds it opaquely). */
export function fromCheckpointTrace(trace: CheckpointTrace | undefined): SpanContextRef | undefined {
  if (!trace || typeof trace !== 'object') return undefined
  return parseTraceparent(trace.traceparent, trace.tracestate)
}
