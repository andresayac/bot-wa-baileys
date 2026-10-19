/**
 * Retry delays of the durability journal: the default capped exponential policy with
 * jitter, and {@link computeBackoff}, which also accepts a user function policy.
 */

import type { RetryBackoff } from './types.js'

/** Default retry policy: 1s, 2s, 4s… capped at 60s, ±20% jitter. */
export const DEFAULT_BACKOFF = { baseMs: 1_000, capMs: 60_000, jitter: 0.2 } as const

/**
 * Delay in ms before the next attempt, after `attempt` (1-based) failed attempts.
 * Capped exponential with symmetric jitter; a function policy is called as-is.
 * Never negative; non-finite results become `0`.
 */
export function computeBackoff(policy: RetryBackoff | undefined, attempt: number, random: () => number = Math.random): number {
  if (typeof policy === 'function') {
    const ms = policy(attempt)
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  }
  const baseMs = policy?.baseMs ?? DEFAULT_BACKOFF.baseMs
  const capMs = policy?.capMs ?? DEFAULT_BACKOFF.capMs
  const jitter = Math.min(1, Math.max(0, policy?.jitter ?? DEFAULT_BACKOFF.jitter))
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
  const ms = exp * (1 + jitter * (random() * 2 - 1))
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
}
