import { describe, expect, it } from 'vitest'

import { formatTraceparent, parseTraceparent } from '../src/index.js'
import { createRecordingTracer } from '../src/testing/index.js'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'

describe('W3C trace context helpers', () => {
  it('formats a span context as a traceparent (flags default to sampled)', () => {
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, traceFlags: 1 })).toBe(`00-${TRACE}-${SPAN}-01`)
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN })).toBe(`00-${TRACE}-${SPAN}-01`)
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, traceFlags: 0 })).toBe(`00-${TRACE}-${SPAN}-00`)
  })

  it('refuses ids that are not W3C-shaped (a custom tracer keeps its own ids)', () => {
    expect(formatTraceparent({ traceId: 'ts1', spanId: 's1' })).toBeUndefined()
    expect(formatTraceparent({ traceId: '0'.repeat(32), spanId: SPAN })).toBeUndefined()
    expect(formatTraceparent({ traceId: TRACE, spanId: '0'.repeat(16) })).toBeUndefined()
    expect(formatTraceparent({ traceId: TRACE.toUpperCase(), spanId: SPAN })).toBeUndefined()
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, traceFlags: 256 })).toBeUndefined()
  })

  it('parses a traceparent (+ tracestate) into a remote span context', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`, 'vendor=abc')).toEqual({
      traceId: TRACE, spanId: SPAN, traceFlags: 1, traceState: 'vendor=abc', isRemote: true,
    })
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)).toEqual({ traceId: TRACE, spanId: SPAN, traceFlags: 0, isRemote: true })
    // A future version may append fields after the flags.
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-extra`)?.spanId).toBe(SPAN)
  })

  it('rejects malformed values', () => {
    for (const bad of [
      '', 'garbage', `ff-${TRACE}-${SPAN}-01`, `00-${TRACE}-${SPAN}-01-extra`, `00-${'0'.repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${'0'.repeat(16)}-01`, `00-${TRACE}-${SPAN}-zz`, `00-${TRACE.slice(1)}-${SPAN}-01`,
    ]) expect(parseTraceparent(bad), bad).toBeUndefined()
    expect(parseTraceparent(42 as unknown as string)).toBeUndefined()
    // An oversized or non-string tracestate is dropped, the traceparent still parses.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`, 'x'.repeat(600))?.traceState).toBeUndefined()
  })

  it('round-trips the recording tracer in w3c mode', () => {
    const rec = createRecordingTracer({ w3c: true, traceState: 'k=v' })
    const ctx = rec.tracer.startSpan('x').spanContext()!
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(parseTraceparent(formatTraceparent(ctx)!, ctx.traceState)).toMatchObject({ traceId: ctx.traceId, spanId: ctx.spanId, traceState: 'k=v' })
  })
})
