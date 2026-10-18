/**
 * Secret-aware redaction for values echoed back to API clients or written to audit logs.
 *
 * Walks objects and arrays recursively and replaces the value of every key that looks
 * like a credential with `'[REDACTED]'`. The match is deliberately broad: over-redacting
 * a harmless field is cheaper than leaking a token.
 */

/** Placeholder written in place of a redacted value. */
export const REDACTED = '[REDACTED]'

const SECRET_KEY = /secret|token|passw|passphrase|^pass$|pin$|authorization|^auth$|api[-_]?key|credential|private|signing|cookie|session|key$|salt$|bearer|cert/i

/** Whether `key` names a value that must not be echoed back. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

const MAX_DEPTH = 32

/** Deep copy of `value` with every secret-looking key replaced by {@link REDACTED}. */
export function redactSecrets<T>(value: T): T {
  return walk(value, 0) as T
}

function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) out[key] = isSecretKey(key) ? REDACTED : walk(v, depth + 1)
  return out
}
