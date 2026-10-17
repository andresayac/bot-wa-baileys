/**
 * In-memory user-data table backing {@link MemoryStore}'s `ctx.user` methods
 * (internal). Values are kept as JSON text, so every read hands out a fresh
 * copy and the semantics match the persistent stores (JSON round-trip).
 * Expiry is lazy: expired entries are invisible to reads and removed by
 * {@link MemoryUserDataTable.purge} or skipped when snapshotting to disk.
 */

import type { UserDataEntry, UserId } from '../core/provider.js'

interface StoredValue {
  json: string
  expiresAt?: number
  updatedAt: number
}

const isLive = (stored: StoredValue, now: number): boolean =>
  stored.expiresAt === undefined || stored.expiresAt > now

export class MemoryUserDataTable {
  /** userId → namespace → key → value */
  private readonly users = new Map<UserId, Map<string, Map<string, StoredValue>>>()

  get(userId: UserId, namespace: string, key: string, now: number): UserDataEntry | undefined {
    const stored = this.users.get(userId)?.get(namespace)?.get(key)
    return stored && isLive(stored, now) ? toEntry(userId, namespace, key, stored) : undefined
  }

  set(entry: UserDataEntry): void {
    const json = JSON.stringify(entry.value)
    if (json === undefined) throw new TypeError('user data value must be JSON-serialisable')
    let namespaces = this.users.get(entry.userId)
    if (!namespaces) {
      namespaces = new Map()
      this.users.set(entry.userId, namespaces)
    }
    let keys = namespaces.get(entry.namespace)
    if (!keys) {
      keys = new Map()
      namespaces.set(entry.namespace, keys)
    }
    const stored: StoredValue = { json, updatedAt: entry.updatedAt }
    if (typeof entry.expiresAt === 'number') stored.expiresAt = entry.expiresAt
    keys.set(entry.key, stored)
  }

  delete(userId: UserId, namespace?: string, key?: string): void {
    if (namespace === undefined) {
      this.users.delete(userId)
      return
    }
    const namespaces = this.users.get(userId)
    if (!namespaces) return
    if (key === undefined) namespaces.delete(namespace)
    else {
      const keys = namespaces.get(namespace)
      keys?.delete(key)
      if (keys && keys.size === 0) namespaces.delete(namespace)
    }
    if (namespaces.size === 0) this.users.delete(userId)
  }

  list(userId: UserId, namespace: string | undefined, now: number): UserDataEntry[] {
    const namespaces = this.users.get(userId)
    if (!namespaces) return []
    const out: UserDataEntry[] = []
    for (const [ns, keys] of namespaces) {
      if (namespace !== undefined && ns !== namespace) continue
      for (const [key, stored] of keys) {
        if (isLive(stored, now)) out.push(toEntry(userId, ns, key, stored))
      }
    }
    return out
  }

  /** Remove expired entries; returns how many were removed. */
  purge(now: number): number {
    let removed = 0
    for (const [userId, namespaces] of this.users) {
      for (const [ns, keys] of namespaces) {
        for (const [key, stored] of keys) {
          if (!isLive(stored, now)) {
            keys.delete(key)
            removed++
          }
        }
        if (keys.size === 0) namespaces.delete(ns)
      }
      if (namespaces.size === 0) this.users.delete(userId)
    }
    return removed
  }

  /** Live entries for the JSON persistence file (expired ones are dropped). */
  snapshot(now: number): UserDataEntry[] {
    const out: UserDataEntry[] = []
    for (const [userId, namespaces] of this.users) {
      for (const [ns, keys] of namespaces) {
        for (const [key, stored] of keys) {
          if (isLive(stored, now)) out.push(toEntry(userId, ns, key, stored))
        }
      }
    }
    return out
  }

  /** Restore from a persistence file; malformed or expired rows are skipped. */
  load(rows: unknown, now: number): void {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const r = row as Partial<Record<keyof UserDataEntry, unknown>>
      if (typeof r.userId !== 'string' || typeof r.namespace !== 'string' || typeof r.key !== 'string') continue
      if (r.value === undefined) continue
      const expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : undefined
      if (expiresAt !== undefined && expiresAt <= now) continue
      const entry: UserDataEntry = {
        userId: r.userId,
        namespace: r.namespace,
        key: r.key,
        value: r.value,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      }
      if (expiresAt !== undefined) entry.expiresAt = expiresAt
      this.set(entry)
    }
  }
}

function toEntry(userId: UserId, namespace: string, key: string, stored: StoredValue): UserDataEntry {
  const entry: UserDataEntry = { userId, namespace, key, value: JSON.parse(stored.json) as unknown, updatedAt: stored.updatedAt }
  if (stored.expiresAt !== undefined) entry.expiresAt = stored.expiresAt
  return entry
}
