/**
 * Webhook authentication helpers (timing-safe, dependency-free).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type HeaderBag = Record<string, string | string[] | undefined>

/** Case-insensitive single-value header read. */
export function headerValue(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    const v = Array.isArray(value) ? value[0] : value
    return typeof v === 'string' ? v : undefined
  }
  return undefined
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `Authorization: Bearer <token>` → `<token>`. */
export function bearerToken(headers: HeaderBag | undefined): string | undefined {
  const auth = headerValue(headers, 'authorization')
  const match = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null
  return match ? match[1].trim() : undefined
}

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export interface JwtCheck {
  /** Current time, epoch seconds. */
  nowSec?: number
  /** Allowed clock skew in seconds. Default 30. */
  skewSec?: number
  /** Claims that must match exactly (e.g. `{ app: 'evolution' }`). */
  claims?: Record<string, unknown>
}

/**
 * Verify an HS256 JWT: signature, `alg`, `exp` (required) and `nbf`/`iat`
 * against the clock, plus any exact-match claims.
 */
export function verifyHs256Jwt(token: string, key: string, check: JwtCheck = {}): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [h, p, s] = parts
  const header = decodeJson(h)
  if (!header || header.alg !== 'HS256') return false
  const expected = b64url(createHmac('sha256', key).update(`${h}.${p}`).digest())
  if (!safeEqual(s, expected)) return false
  const payload = decodeJson(p)
  if (!payload) return false
  const now = check.nowSec ?? Math.floor(Date.now() / 1000)
  const skew = check.skewSec ?? 30
  if (typeof payload.exp !== 'number' || payload.exp + skew < now) return false
  if (typeof payload.nbf === 'number' && payload.nbf - skew > now) return false
  if (typeof payload.iat === 'number' && payload.iat - skew > now) return false
  for (const [claim, value] of Object.entries(check.claims ?? {})) {
    if (payload[claim] !== value) return false
  }
  return true
}

/** Sign an HS256 JWT — used by tests and handy to emulate Evolution's `jwt_key` header. */
export function signHs256Jwt(payload: Record<string, unknown>, key: string): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const p = b64url(Buffer.from(JSON.stringify(payload)))
  const s = b64url(createHmac('sha256', key).update(`${h}.${p}`).digest())
  return `${h}.${p}.${s}`
}
