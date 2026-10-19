/**
 * Minimal fenced lease contract, shared by the persistent scheduler (leadership) and,
 * later, by the multi-replica coordinator.
 *
 * NOTE (unification): the multi-replica coordinator owns this folder. When it ships its
 * `Coordinator` (fenced, numeric tokens), `LeaseProvider` must become a subset of it or a
 * type alias, never a second incompatible lease type.
 */

/** A granted lease: `token` is a fencing token, strictly increasing per key. */
export interface LeaseGrant {
  token: number
}

/**
 * A fenced, expiring lease per key. Implementations must make each call atomic:
 * - `acquire` grants the key when it is free or expired (a new, larger token), or
 *   extends it when `owner` already holds it (same token); else returns `null`.
 * - `renew` extends the lease only when `owner` still holds it with `token`.
 * - `release` frees the key only when `owner` holds it with `token` (else no-op).
 * Tokens never go backwards for a key, even across release and expiry.
 */
export interface LeaseProvider {
  acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant | null>
  renew(key: string, owner: string, token: number, ttlMs: number): Promise<boolean>
  release(key: string, owner: string, token: number): Promise<void>
}

interface LeaseRow { owner?: string; token: number; until: number }

/**
 * In-process {@link LeaseProvider}, the reference implementation of the contract. Only
 * useful within one process (tests, or several schedulers sharing it).
 */
export class MemoryLeaseProvider implements LeaseProvider {
  private readonly rows = new Map<string, LeaseRow>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<LeaseGrant | null> {
    assertTtl(ttlMs)
    const now = this.now()
    const row = this.rows.get(key)
    if (row?.owner !== undefined && row.until > now) {
      if (row.owner !== owner) return null
      row.until = now + ttlMs
      return { token: row.token }
    }
    const token = (row?.token ?? 0) + 1
    this.rows.set(key, { owner, token, until: now + ttlMs })
    return { token }
  }

  async renew(key: string, owner: string, token: number, ttlMs: number): Promise<boolean> {
    assertTtl(ttlMs)
    const now = this.now()
    const row = this.rows.get(key)
    if (!row || row.owner !== owner || row.token !== token || row.until <= now) return false
    row.until = now + ttlMs
    return true
  }

  async release(key: string, owner: string, token: number): Promise<void> {
    const row = this.rows.get(key)
    if (row && row.owner === owner && row.token === token) {
      row.owner = undefined
      row.until = 0
    }
  }
}

/** Shared ttl check of the lease implementations. */
export function assertTtl(ttlMs: number): void {
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) {
    throw new RangeError(`lease ttlMs must be a positive number of milliseconds, got ${String(ttlMs)}`)
  }
}
