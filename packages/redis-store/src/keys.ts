/**
 * Key enumeration for RedisStore (internal).
 */
import type { RedisLikeClient } from './RedisStore.js'

/** COUNT hint per SCAN step: large enough to keep round trips low, small enough not to block the server. */
const SCAN_COUNT = 500

/**
 * Every key matching the glob `pattern`.
 *
 * Uses incremental `SCAN` (the client's `scanIterator`, present on node-redis)
 * when available: `KEYS` walks the whole keyspace in one blocking command,
 * stalling every other client of a shared Redis while it runs. Falls back to
 * `KEYS` for clients without `scanIterator`. SCAN may report a key more than
 * once, so the result is de-duplicated; a key created or deleted during the
 * scan may or may not be included (callers re-read each key anyway).
 */
export async function matchKeys(client: RedisLikeClient, pattern: string): Promise<string[]> {
  if (typeof client.scanIterator !== 'function') return client.keys(pattern)
  const seen = new Set<string>()
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: SCAN_COUNT })) {
    // node-redis v4 yields one key per step, v5 an array of keys.
    if (Array.isArray(batch)) for (const key of batch) seen.add(key)
    else seen.add(batch)
  }
  return [...seen]
}
