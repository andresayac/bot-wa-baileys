/**
 * Shared normalizer for {@link InboundLocation} — providers call it while mapping an
 * inbound location so every channel applies the same validation.
 */

import type { InboundLocation } from './provider.js'

/** Raw fields a provider read from its transport payload (any of them may be missing or junk). */
export interface InboundLocationInput {
  latitude?: unknown
  longitude?: unknown
  name?: unknown
  address?: unknown
  live?: unknown
}

/**
 * Build a normalized {@link InboundLocation}, or `undefined` when the coordinates are
 * missing, not finite or out of range (latitude −90…90, longitude −180…180). Numeric
 * strings are accepted; empty `name`/`address` strings are dropped; `live` is set only
 * when `true`.
 *
 * @example
 * ```ts
 * const location = toInboundLocation({ latitude: msg.location?.latitude, longitude: msg.location?.longitude, name: msg.location?.name })
 * ```
 */
export function toInboundLocation(input: InboundLocationInput | null | undefined): InboundLocation | undefined {
  if (!input) return undefined
  const latitude = coordinate(input.latitude, 90)
  const longitude = coordinate(input.longitude, 180)
  if (latitude === undefined || longitude === undefined) return undefined
  const location: InboundLocation = { latitude, longitude }
  if (typeof input.name === 'string' && input.name.trim()) location.name = input.name
  if (typeof input.address === 'string' && input.address.trim()) location.address = input.address
  if (input.live === true) location.live = true
  return location
}

function coordinate(value: unknown, limit: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined
}
