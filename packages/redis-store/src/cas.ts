/**
 * Optimistic compare-and-set over one JSON string key (internal), shared by the
 * schedule store and the lease provider: read, decide in JS, then write with
 * {@link MERGE_CAS_SCRIPT} only if the key still holds what was read; on a
 * conflict, re-read and decide again.
 */
import type { RedisLikeClient } from './RedisStore.js'
import { MERGE_CAS_SCRIPT } from './scripts.js'

/** Re-reads allowed under contention before giving up (each one means another writer won). */
const MAX_CAS_ATTEMPTS = 64

export interface CasDecision<T, R> {
  /** The new value to write; omitted (`undefined`) to leave the key as it is. */
  next?: T
  result: R
}

export async function casJson<T, R>(
  client: RedisLikeClient,
  key: string,
  decide: (current: T | null) => CasDecision<T, R>,
): Promise<R> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const raw = await client.get(key)
    const current = raw == null ? null : (JSON.parse(String(raw)) as T)
    const { next, result } = decide(current)
    if (next === undefined) return result
    const written = await client.eval(MERGE_CAS_SCRIPT, {
      keys: [key],
      arguments: raw == null ? ['0', '', JSON.stringify(next)] : ['1', String(raw), JSON.stringify(next)],
    })
    if (Number(written) === 1) return result
  }
  throw new Error(`redis-store: compare-and-set on ${key} kept conflicting (${MAX_CAS_ATTEMPTS} attempts)`)
}
