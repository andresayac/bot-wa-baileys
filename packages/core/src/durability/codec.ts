/**
 * JSON codec for journaled payloads (internal): inbound events and outbound content.
 *
 * Buffers / typed arrays become `{ $b64 }` and Dates `{ $date }`; functions, symbols and
 * `undefined` are dropped (as JSON does); a stream or a cycle makes the value
 * unencodable (`undefined`), and the caller then bypasses the journal.
 */

import type { InboundEvent } from '../core/provider.js'
import type { JsonValue } from './types.js'

class Unencodable extends Error {}

function enc(value: unknown, seen: Set<object>): JsonValue | undefined {
  if (value === null) return null
  switch (typeof value) {
    case 'string': case 'boolean': return value
    case 'number': return Number.isFinite(value) ? value : null
    case 'bigint': return value.toString()
    case 'undefined': case 'function': case 'symbol': return undefined
  }
  const obj = value as object
  if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
    return { $b64: Buffer.from(obj as Uint8Array).toString('base64') }
  }
  if (obj instanceof Date) return { $date: obj.toISOString() }
  if (typeof (obj as { pipe?: unknown }).pipe === 'function' || typeof (obj as { then?: unknown }).then === 'function') {
    throw new Unencodable('stream/promise')
  }
  if (seen.has(obj)) throw new Unencodable('cycle')
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((v) => enc(v, seen) ?? null)
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(obj)) {
      const e = enc(v, seen)
      if (e !== undefined) out[k] = e
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

/** Encode `value` as JSON-safe data, or `undefined` when it cannot be (a stream, a cycle). */
export function encodeJson(value: unknown): JsonValue | undefined {
  try { return enc(value, new Set()) } catch (error) {
    if (error instanceof Unencodable) return undefined
    throw error
  }
}

/** Inverse of {@link encodeJson}. */
export function decodeJson<T = unknown>(value: JsonValue | undefined): T {
  return dec(value) as T
}

function dec(value: JsonValue | undefined): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(dec)
  const keys = Object.keys(value)
  if (keys.length === 1 && typeof value.$b64 === 'string') return Buffer.from(value.$b64, 'base64')
  if (keys.length === 1 && typeof value.$date === 'string') return new Date(value.$date)
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = dec(value[k])
  return out
}

/** The journaled form of an inbound message/interaction: `raw` is never stored. */
export function encodeInbound(event: InboundEvent): JsonValue | undefined {
  if (event.kind === 'message') {
    const { raw: _raw, ...message } = event.message
    return encodeJson({ kind: 'message', message })
  }
  if (event.kind === 'interaction') {
    const { raw: _raw, ...interaction } = event.interaction
    return encodeJson({ kind: 'interaction', interaction })
  }
  return undefined
}

/** Rebuild a journaled inbound event (`raw` is `undefined`). */
export function decodeInbound(payload: JsonValue): InboundEvent {
  return decodeJson<InboundEvent>(payload)
}

/** Encoded size of a journaled value in bytes (UTF-8 JSON). */
export function encodedSize(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
