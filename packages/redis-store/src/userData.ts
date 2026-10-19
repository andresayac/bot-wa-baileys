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
 *
 * Cluster key layout: `{prefix}:{ud:<user>}:e:<ns>:<key>` plus a per-user index sorted
 * set `{prefix}:{ud:<user>}:idx` (member `<ns>:<key>`, score = server expiry ms or +inf)
 * in the same hash slot, updated atomically with every write; listing and bulk deletes
 * read the index instead of scanning (KEYS/SCAN only see one node of a cluster).
 */

import type { UserDataEntry, UserId } from '@bot-wa/core'
import type { RedisLikeClient } from './RedisStore.js'
import { escapeGlob } from './glob.js'
import { matchKeys } from './keys.js'
import { CAS_INDEXED_SCRIPT, DELETE_BATCH_SCRIPT, DEL_INDEXED_SCRIPT, LIVE_INDEX_SCRIPT } from './clusterScripts.js'
import { userDataKeys, type RedisKeyLayout, type UserDataKeys } from './layout.js'
import { assertOneSlot } from './slot.js'

/** Entries deleted per script call by a bulk delete in the cluster layout. */
const DELETE_CHUNK = 500

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
  private readonly keys: UserDataKeys
  private readonly cluster: boolean

  constructor(private readonly client: RedisLikeClient, prefix: string, layout: RedisKeyLayout = 'legacy') {
    this.base = `${prefix}:ud:`
    this.keys = userDataKeys(prefix, layout)
    this.cluster = layout === 'cluster'
  }

  private itemKey(userId: UserId, namespace: string, key: string): string {
    return this.keys.entry(userId, namespace, key)
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
    // `{ value: undefined }` would serialise to a payload without a value and
    // read back as `undefined`; reject it like MemoryStore does.
    if (JSON.stringify(entry.value) === undefined) throw new TypeError('user data value must be JSON-serialisable')
    const itemKey = this.itemKey(entry.userId, entry.namespace, entry.key)
    const payload: StoredPayload = { value: entry.value, updatedAt: entry.updatedAt }
    if (this.cluster) return this.setIndexed(entry, itemKey, payload, now)
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

  /** Cluster layout: the entry and its index member in one script (same slot). */
  private async setIndexed(entry: UserDataEntry, itemKey: string, payload: StoredPayload, now: number): Promise<void> {
    const index = this.keys.index(entry.userId)!
    const member = this.keys.member(entry.namespace, entry.key)
    assertOneSlot([itemKey, index])
    let px = ''
    if (entry.expiresAt != null) {
      const ttlMs = Math.ceil(entry.expiresAt - now)
      if (ttlMs <= 0) {
        await this.client.eval(DEL_INDEXED_SCRIPT, { keys: [itemKey, index], arguments: [member] })
        return
      }
      payload.expiresAt = entry.expiresAt
      px = String(ttlMs)
    }
    await this.client.eval(CAS_INDEXED_SCRIPT, { keys: [itemKey, index], arguments: ['*', '', JSON.stringify(payload), member, px] })
  }

  /** Cluster layout: the live index members of a user, optionally of one namespace, as [member, ns, key]. */
  private async indexed(userId: UserId, namespace: string | undefined, prune: boolean): Promise<Array<{ member: string; ns: string; key: string }>> {
    const index = this.keys.index(userId)!
    const members = prune
      ? ((await this.client.eval(LIVE_INDEX_SCRIPT, { keys: [index] })) as unknown[]).map(String)
      : await this.client.zRange(index, 0, -1)
    const out: Array<{ member: string; ns: string; key: string }> = []
    for (const member of members) {
      const parts = member.split(':')
      if (parts.length !== 2) continue
      const [ns, key] = parts.map(decodeURIComponent) as [string, string]
      if (namespace !== undefined && ns !== namespace) continue
      out.push({ member, ns, key })
    }
    return out
  }

  async delete(userId: UserId, namespace?: string, key?: string): Promise<void> {
    if (this.cluster) return this.deleteIndexed(userId, namespace, key)
    if (namespace !== undefined && key !== undefined) {
      await this.client.del(this.itemKey(userId, namespace, key))
      return
    }
    const keys = await matchKeys(this.client, this.pattern(userId, namespace))
    if (keys.length) await this.client.del(keys)
  }

  private async deleteIndexed(userId: UserId, namespace?: string, key?: string): Promise<void> {
    const index = this.keys.index(userId)!
    if (namespace !== undefined && key !== undefined) {
      const itemKey = this.itemKey(userId, namespace, key)
      assertOneSlot([itemKey, index])
      await this.client.eval(DEL_INDEXED_SCRIPT, { keys: [itemKey, index], arguments: [this.keys.member(namespace, key)] })
      return
    }
    const entries = await this.indexed(userId, namespace, false)
    for (let i = 0; i < entries.length; i += DELETE_CHUNK) {
      const chunk = entries.slice(i, i + DELETE_CHUNK)
      const keys = [index, ...chunk.map((e) => this.itemKey(userId, e.ns, e.key))]
      assertOneSlot(keys)
      await this.client.eval(DELETE_BATCH_SCRIPT, { keys, arguments: chunk.map((e) => e.member) })
    }
  }

  async list(userId: UserId, namespace: string | undefined, now: number): Promise<UserDataEntry[]> {
    if (this.cluster) {
      const entries = await this.indexed(userId, namespace, true)
      const raws = await Promise.all(entries.map((e) => this.client.get(this.itemKey(userId, e.ns, e.key))))
      const out: UserDataEntry[] = []
      entries.forEach(({ ns, key }, i) => {
        const entry = this.parse(toStr(raws[i]), userId, ns, key, now)
        if (entry) out.push(entry)
      })
      return out
    }
    const keys = await matchKeys(this.client, this.pattern(userId, namespace))
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
