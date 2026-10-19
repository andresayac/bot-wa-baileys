/**
 * The `telemetry.ids` policy: how chat, sender and message ids appear on spans. The core
 * never parses an id — it only hashes (HMAC-SHA256), passes or drops the opaque string.
 */
import { createHmac, randomBytes } from 'node:crypto'

import type { TelemetryConfig } from './types.js'

export type IdPolicy = (id: string) => string | undefined

export function createIdPolicy(cfg: Pick<TelemetryConfig, 'ids' | 'idKey'>): IdPolicy {
  const mode = cfg.ids ?? 'hash'
  if (mode === 'omit') return () => undefined
  if (mode === 'raw') return (id) => id
  const key = cfg.idKey ?? randomBytes(32)
  return (id) => createHmac('sha256', key).update(id).digest('base64url').slice(0, 16)
}
