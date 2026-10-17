/**
 * `ctx.user` storage for {@link RedisStore} (internal).
 *
 * One string key per entry — `{prefix}:ud:{user}:{namespace}:{key}` holding
 * JSON `{ value, expiresAt?, updatedAt }` — with NATIVE expiry: a write with
 * `expiresAt` uses `SET … PX`, so Redis drops the key itself and
 * `purgeExpiredUserData` has nothing to do. Every segment is percent-encoded
 * (`encodeURIComponent` plus `*`), so ids containing `:` or glob characters can
 * neither collide nor widen the `KEYS` patterns used for namespace/user scans; the
 * store prefix itself is glob-escaped in those patterns, like the store's other scans.
 * TTLs go out as a positive integer `PX` (the server rejects fractions).
 */

import type { UserDataEntry, UserId } from '@bot-wa/core'
import type { RedisLikeClient } from './RedisStore.js'
import { escapeGlob } from './glob.js'

interface StoredPayload {
  value: unknown
  expiresAt?: number
  updatedAt: number
}

/** Percent-encode a key segment: no `:` separators and no glob metacharacters survive. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/\*/g, '%2A')
}

function toStr(value: string | Buffer | null | undefined): string | null {
  if (value == null) return null
  return typeof value === 'string' ? value : value.toString()
}

export class RedisUserData {
  private readonly base: string

  constructor(private readonly client: RedisLikeClient, prefix: string) {
    this.base = `${prefix}:ud:`
  }

  private itemKey(userId: UserId, namespace: string, key: string): string {
    return `${this.base}${encodeSegment(userId)}:${encodeSegment(namespace)}:${encodeSegment(key)}`
  }

  /** KEYS pattern for a user (optionally one namespace). Encoded segments contain no glob chars; the prefix is escaped. */
  private pattern(userId: UserId, namespace?: string): string {
    const user = `${escapeGlob(this.base)}${encodeSegment(userId)}:`
    return namespace === undefined ? `${user}*` : `${user}${encodeSegment(namespace)}:*`
  }

  private parse(raw: string | null, userId: UserId, namespace: string, key: string, now: number): UserDataEntry | undefined {
    if (raw == null) return undefined
    const payload = JSON.parse(raw) as StoredPayload
    // Native PX already expired it; this guards clock skew between app and Redis.
    if (typeof payload.expiresAt === 'number' && payload.expiresAt <= now) return undefined
    const entry: UserDataEntry = { userId, namespace, key, value: payload.value, updatedAt: payload.updatedAt }
    if (typeof payload.expiresAt === 'number') entry.expiresAt = payload.expiresAt
    return entry
  }

  async get(userId: UserId, namespace: string, key: string, now: number): Promise<UserDataEntry | undefined> {
    const raw = toStr(await this.client.get(this.itemKey(userId, namespace, key)))
    return this.parse(raw, userId, namespace, key, now)
  }

  async set(entry: UserDataEntry, now: number): Promise<void> {
    const itemKey = this.itemKey(entry.userId, entry.namespace, entry.key)
    const payload: StoredPayload = { value: entry.value, updatedAt: entry.updatedAt }
    if (entry.expiresAt == null) {
      // Plain SET also discards any TTL left by a previous write.
      await this.client.set(itemKey, JSON.stringify(payload))
      return
    }
    // PX takes a positive integer only: round partial milliseconds up so the entry never expires early.
    const ttlMs = Math.ceil(entry.expiresAt - now)
    if (ttlMs <= 0) {
      // Already expired: Redis rejects a non-positive PX, and absent is the right state.
      await this.client.del(itemKey)
      return
    }
    payload.expiresAt = entry.expiresAt
    await this.client.set(itemKey, JSON.stringify(payload), { PX: ttlMs })
  }

  async delete(userId: UserId, namespace?: string, key?: string): Promise<void> {
    if (namespace !== undefined && key !== undefined) {
      await this.client.del(this.itemKey(userId, namespace, key))
      return
    }
    const keys = await this.client.keys(this.pattern(userId, namespace))
    if (keys.length) await this.client.del(keys)
  }

  async list(userId: UserId, namespace: string | undefined, now: number): Promise<UserDataEntry[]> {
    const keys = await this.client.keys(this.pattern(userId, namespace))
    const owned: Array<{ itemKey: string; ns: string; key: string }> = []
    for (const itemKey of keys) {
      const parts = itemKey.slice(this.base.length).split(':')
      if (parts.length !== 3) continue
      const [user, ns, key] = parts.map(decodeURIComponent) as [string, string, string]
      if (user !== userId || (namespace !== undefined && ns !== namespace)) continue
      owned.push({ itemKey, ns, key })
    }
    const raws = await Promise.all(owned.map(({ itemKey }) => this.client.get(itemKey)))
    const out: UserDataEntry[] = []
    owned.forEach(({ ns, key }, i) => {
      // A key may expire between KEYS and GET — parse() treats null as absent.
      const entry = this.parse(toStr(raws[i]), userId, ns, key, now)
      if (entry) out.push(entry)
    })
    return out
  }
}
