/**
 * Webhook authentication helpers (timing-safe, dependency-free).
 */

import { timingSafeEqual } from 'node:crypto'

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
