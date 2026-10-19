/**
 * RedisLeaseProvider — a fenced, expiring {@link LeaseProvider} on Redis.
 *
 * One JSON record per key at `{prefix}:lease:{key}` holding the owner, the deadline and
 * a fencing token that only grows (the record is never deleted, so the token survives
 * release and expiry). Mutations are compare-and-set, like {@link RedisScheduleStore}.
 * Deadlines use this process's clock (`Date.now()`): keep replica clocks in sync.
 *
 * Unlike {@link RedisStore.acquireLock}, every grant carries a monotonic token, so a
 * protected resource can reject a stale holder.
 *
 * Every operation touches one key, so the same key names work on Redis Cluster; the
 * `layout` option only validates the prefix for the cluster layout.
 */
import type { LeaseGrant, LeaseProvider } from '@bot-wa/core'
import type { RedisLikeClient } from './RedisStore.js'
import { casJson } from './cas.js'
import { asRedisLike, resolveLayout, type AnyRedisClient } from './client.js'
import { assertLayoutPrefix, type RedisKeyLayout } from './layout.js'

interface LeaseRecord {
  owner?: string
  token: number
  until: number
}

export interface RedisLeaseProviderOptions {
  /** A connected node-redis client or any {@link RedisLikeClient}; the caller owns its lifecycle. */
  client: AnyRedisClient
  /** Key prefix (default `'botwa'`): leases live at `{prefix}:lease:{key}`. */
  prefix?: string
  /** Key layout (same key names in both; `'cluster'` rejects a prefix with hash-tag braces). Default as `RedisStoreOptions.layout`. */
  layout?: RedisKeyLayout
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number
}

function assertTtl(ttlMs: number): void {
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) {
    throw new RangeError(`lease ttlMs must be a positive number of milliseconds, got ${String(ttlMs)}`)
  }
}

export class RedisLeaseProvider implements LeaseProvider {
  private readonly client: RedisLikeClient
  private readonly ns: string
  private readonly now: () => number

  constructor(opts: RedisLeaseProviderOptions) {
    this.client = asRedisLike(opts.client)
    const layout = resolveLayout('RedisLeaseProvider', { layout: opts.layout, client: opts.client })
    assertLayoutPrefix(opts.prefix ?? 'botwa', layout, 'RedisLeaseProvider')
    this.ns = `${opts.prefix ?? 'botwa'}:lease:`
    this.now = opts.now ?? Date.now
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant | null> {
    assertTtl(ttlMs)
    return casJson<LeaseRecord, LeaseGrant | null>(this.client, this.ns + key, (current) => {
      const now = this.now()
      if (current?.owner !== undefined && current.until > now) {
        if (current.owner !== owner) return { result: null }
        return { next: { ...current, until: now + ttlMs }, result: { token: current.token } }
      }
      const token = (current?.token ?? 0) + 1
      return { next: { owner, token, until: now + ttlMs }, result: { token } }
    })
  }

  async renew(key: string, owner: string, token: number, ttlMs: number): Promise<boolean> {
    assertTtl(ttlMs)
    return casJson<LeaseRecord, boolean>(this.client, this.ns + key, (current) => {
      const now = this.now()
      if (!current || current.owner !== owner || current.token !== token || current.until <= now) return { result: false }
      return { next: { ...current, until: now + ttlMs }, result: true }
    })
  }

  async release(key: string, owner: string, token: number): Promise<void> {
    await casJson<LeaseRecord, void>(this.client, this.ns + key, (current) => {
      if (!current || current.owner !== owner || current.token !== token) return { result: undefined }
      return { next: { token: current.token, until: 0 }, result: undefined }
    })
  }
}
