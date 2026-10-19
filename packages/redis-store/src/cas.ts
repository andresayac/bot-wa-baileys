/**
 * Optimistic compare-and-set over one JSON string key (internal), shared by the
 * schedule store and the lease provider: read, decide in JS, then write with
 * {@link MERGE_CAS_SCRIPT} only if the key still holds what was read; on a
 * conflict, re-read and decide again.
 */
import type { RedisLikeClient } from './RedisStore.js'
import { MERGE_CAS_SCRIPT } from './scripts.js'
import { CAS_INDEXED_SCRIPT } from './clusterScripts.js'
import { assertOneSlot } from './slot.js'

/** Re-reads allowed under contention before giving up (each one means another writer won). */
const MAX_CAS_ATTEMPTS = 64

export interface CasDecision<T, R> {
  /** The new value to write; omitted (`undefined`) to leave the key as it is. */
  next?: T
  result: R
}

/**
 * Cluster key layout: the index sorted set that lists the record (same hash slot), kept
 * in step with every write by {@link CAS_INDEXED_SCRIPT}.
 */
export interface CasIndex {
  key: string
  member: string
}

export async function casJson<T, R>(
  client: RedisLikeClient,
  key: string,
  decide: (current: T | null) => CasDecision<T, R>,
  index?: CasIndex,
): Promise<R> {
  if (index) assertOneSlot([key, index.key])
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const raw = await client.get(key)
    const current = raw == null ? null : (JSON.parse(String(raw)) as T)
    const { next, result } = decide(current)
    if (next === undefined) return result
    const expected = raw == null ? ['0', ''] : ['1', String(raw)]
    const written = index
      ? await client.eval(CAS_INDEXED_SCRIPT, { keys: [key, index.key], arguments: [...expected, JSON.stringify(next), index.member, ''] })
      : await client.eval(MERGE_CAS_SCRIPT, { keys: [key], arguments: [...expected, JSON.stringify(next)] })
    if (Number(written) === 1) return result
  }
  throw new Error(`redis-store: compare-and-set on ${key} kept conflicting (${MAX_CAS_ATTEMPTS} attempts)`)
}
