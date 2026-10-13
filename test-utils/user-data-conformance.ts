/**
 * Shared user-data (`ctx.user`) conformance suite for IStore implementations.
 *
 * Runs one set of assertions against EVERY store that implements the optional
 * user-data contract of `IStore` (`getUserData` / `setUserData` /
 * `deleteUserData` / `listUserData` / `purgeExpiredUserData`): MemoryStore,
 * NamespacedStore and the five persistent stores. Wire it from a store's
 * `tests/conformance.test.ts`:
 *
 * ```ts
 * import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'
 * runUserDataConformance('MyStore', { async make() { ... return { store, teardown } } })
 * ```
 *
 * Expiry is exercised with a faked `Date` only (`vi.useFakeTimers({ toFake: ['Date'] })`),
 * so stores that compute "now" in JS (every built-in one, and the in-memory
 * fakes behind the persistent stores' unit tests) observe the simulated clock.
 * Type-only imports keep this file runtime-dependency-free.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IStore, UserDataEntry } from '@bot-wa/core'

export interface UserDataConformanceHarness {
  /** Build a fresh, started store and a teardown that releases it. */
  make(): Promise<{ store: IStore; teardown: () => Promise<void> }>
}

/** The user-data slice of IStore with every method required. */
interface UserDataMethods {
  getUserData(userId: string, namespace: string, key: string): Promise<UserDataEntry | undefined>
  setUserData(entry: UserDataEntry): Promise<void>
  deleteUserData(userId: string, namespace?: string, key?: string): Promise<void>
  listUserData(userId: string, namespace?: string): Promise<UserDataEntry[]>
  purgeExpiredUserData(now?: number): Promise<number>
}

function userDataOf(store: IStore): UserDataMethods {
  const { getUserData, setUserData, deleteUserData, listUserData, purgeExpiredUserData } = store
  if (!getUserData || !setUserData || !deleteUserData || !listUserData || !purgeExpiredUserData) {
    throw new Error('store does not implement the full user-data contract')
  }
  return {
    getUserData: getUserData.bind(store),
    setUserData: setUserData.bind(store),
    deleteUserData: deleteUserData.bind(store),
    listUserData: listUserData.bind(store),
    purgeExpiredUserData: purgeExpiredUserData.bind(store),
  }
}

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

const entry = (userId: string, namespace: string, key: string, value: unknown, extra: Partial<UserDataEntry> = {}): UserDataEntry => ({
  userId, namespace, key, value, updatedAt: T0, ...extra,
})

/** Stable order for list assertions (list order is unspecified by the contract). */
const sorted = (entries: UserDataEntry[]): UserDataEntry[] =>
  [...entries].sort((a, b) => (a.namespace + '\u0000' + a.key).localeCompare(b.namespace + '\u0000' + b.key))

export function runUserDataConformance(name: string, h: UserDataConformanceHarness): void {
  describe(`IStore user-data conformance: ${name}`, () => {
    let store: IStore
    let ud: UserDataMethods
    let teardown: () => Promise<void>

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(T0)
      const made = await h.make()
      store = made.store
      teardown = made.teardown
      ud = userDataOf(store)
    })
    afterEach(async () => {
      try { await teardown() } finally { vi.useRealTimers() }
    })

    it('implements every user-data method', () => {
      expect(typeof store.getUserData).toBe('function')
      expect(typeof store.setUserData).toBe('function')
      expect(typeof store.deleteUserData).toBe('function')
      expect(typeof store.listUserData).toBe('function')
      expect(typeof store.purgeExpiredUserData).toBe('function')
    })

    it('returns undefined for a missing entry and [] for an unknown user', async () => {
      expect(await ud.getUserData('nobody', 'default', 'name')).toBeUndefined()
      expect(await ud.listUserData('nobody')).toEqual([])
      expect(await ud.listUserData('nobody', 'default')).toEqual([])
    })

    it('round-trips every JSON value type with its metadata', async () => {
      const values: Record<string, unknown> = {
        str: 'Juan',
        num: 42.5,
        zero: 0,
        bool: false,
        nil: null,
        arr: [1, 'two', { three: 3 }],
        obj: { address: { city: 'Bogotá', zip: '110111' }, tags: ['a', 'b'], emoji: '🎲' },
        empty: {},
      }
      for (const [key, value] of Object.entries(values)) {
        await ud.setUserData(entry('u1', 'default', key, value, { updatedAt: T0 + 7 }))
      }
      for (const [key, value] of Object.entries(values)) {
        // toEqual: `expiresAt` must be absent/undefined — never `null`.
        expect(await ud.getUserData('u1', 'default', key)).toEqual({
          userId: 'u1', namespace: 'default', key, value, updatedAt: T0 + 7,
        })
      }
    })

    it('keeps an explicit expiresAt in the returned entry', async () => {
      await ud.setUserData(entry('u1', 'game', 'board', [[0, 1]], { expiresAt: T0 + 60_000 }))
      expect(await ud.getUserData('u1', 'game', 'board')).toEqual({
        userId: 'u1', namespace: 'game', key: 'board', value: [[0, 1]], expiresAt: T0 + 60_000, updatedAt: T0,
      })
    })

    it('setUserData replaces both value and expiry (upsert)', async () => {
      await ud.setUserData(entry('u1', 'default', 'k', { a: 1, b: 2 }, { expiresAt: T0 + 1_000 }))
      await ud.setUserData(entry('u1', 'default', 'k', { a: 3 }, { updatedAt: T0 + 5 }))
      const got = await ud.getUserData('u1', 'default', 'k')
      expect(got?.value).toEqual({ a: 3 })
      expect(got?.expiresAt).toBeUndefined()
      expect(got?.updatedAt).toBe(T0 + 5)
      vi.setSystemTime(T0 + 10_000) // the old expiry no longer applies
      expect((await ud.getUserData('u1', 'default', 'k'))?.value).toEqual({ a: 3 })
    })

    it('isolates entries by user, namespace and key', async () => {
      await ud.setUserData(entry('u1', 'default', 'lang', 'es'))
      await ud.setUserData(entry('u2', 'default', 'lang', 'en'))
      await ud.setUserData(entry('u1', 'akinator', 'lang', 'pt'))
      await ud.setUserData(entry('u1', 'default', 'name', 'Juan'))
      expect((await ud.getUserData('u1', 'default', 'lang'))?.value).toBe('es')
      expect((await ud.getUserData('u2', 'default', 'lang'))?.value).toBe('en')
      expect((await ud.getUserData('u1', 'akinator', 'lang'))?.value).toBe('pt')
      expect((await ud.getUserData('u1', 'default', 'name'))?.value).toBe('Juan')
      expect(await ud.getUserData('u2', 'akinator', 'lang')).toBeUndefined()
    })

    it('never confuses ids that contain separators or glob characters', async () => {
      // Same concatenation, different split — must stay distinct.
      await ud.setUserData(entry('a:b', 'c', 'k', 1))
      await ud.setUserData(entry('a', 'b:c', 'k', 2))
      await ud.setUserData(entry('a|b', 'c|d', 'k|e', 3))
      const odd = 'user*?[x]%20 ü 🎲\\'
      await ud.setUserData(entry(odd, 'ns.with.dots', 'key*', 4))
      await ud.setUserData(entry('user', 'ns.with.dots', 'key*', 5)) // prefix of `odd`, must not leak
      expect((await ud.getUserData('a:b', 'c', 'k'))?.value).toBe(1)
      expect((await ud.getUserData('a', 'b:c', 'k'))?.value).toBe(2)
      expect((await ud.getUserData('a|b', 'c|d', 'k|e'))?.value).toBe(3)
      expect(await ud.listUserData('a')).toEqual([entry('a', 'b:c', 'k', 2)])
      expect(await ud.listUserData('a:b')).toEqual([entry('a:b', 'c', 'k', 1)])
      expect(await ud.listUserData(odd)).toEqual([entry(odd, 'ns.with.dots', 'key*', 4)])
      await ud.deleteUserData('user')
      expect((await ud.getUserData(odd, 'ns.with.dots', 'key*'))?.value).toBe(4)
    })

    it('treats ids, namespaces and keys as exact (case- and accent-sensitive) strings', async () => {
      await ud.setUserData(entry('Juan', 'Game', 'Name', 1))
      await ud.setUserData(entry('juan', 'game', 'name', 2))
      await ud.setUserData(entry('juán', 'gáme', 'námé', 3))
      expect((await ud.getUserData('Juan', 'Game', 'Name'))?.value).toBe(1)
      expect((await ud.getUserData('juan', 'game', 'name'))?.value).toBe(2)
      expect((await ud.getUserData('juán', 'gáme', 'námé'))?.value).toBe(3)
      expect(await ud.getUserData('JUAN', 'Game', 'Name')).toBeUndefined()
      expect(await ud.listUserData('juan')).toEqual([entry('juan', 'game', 'name', 2)])
    })

    it('lists every namespace of a user, or just one namespace', async () => {
      await ud.setUserData(entry('u1', 'default', 'name', 'Juan'))
      await ud.setUserData(entry('u1', 'default', 'lang', 'es'))
      await ud.setUserData(entry('u1', 'game', 'score', 10, { expiresAt: T0 + 60_000 }))
      await ud.setUserData(entry('u2', 'default', 'name', 'Ana'))
      expect(sorted(await ud.listUserData('u1'))).toEqual([
        entry('u1', 'default', 'lang', 'es'),
        entry('u1', 'default', 'name', 'Juan'),
        entry('u1', 'game', 'score', 10, { expiresAt: T0 + 60_000 }),
      ])
      expect(await ud.listUserData('u1', 'game')).toEqual([entry('u1', 'game', 'score', 10, { expiresAt: T0 + 60_000 })])
      expect(await ud.listUserData('u1', 'missing')).toEqual([])
    })

    it('deletes one key, one namespace, or every namespace of a user', async () => {
      for (const user of ['u1', 'u2']) {
        await ud.setUserData(entry(user, 'default', 'a', 1))
        await ud.setUserData(entry(user, 'default', 'b', 2))
        await ud.setUserData(entry(user, 'game', 'c', 3))
        await ud.setUserData(entry(user, 'quiz', 'd', 4))
      }
      await ud.deleteUserData('u1', 'default', 'a')
      expect(await ud.getUserData('u1', 'default', 'a')).toBeUndefined()
      expect((await ud.getUserData('u1', 'default', 'b'))?.value).toBe(2)

      await ud.deleteUserData('u1', 'game')
      expect(await ud.listUserData('u1', 'game')).toEqual([])
      expect(await ud.listUserData('u1', 'quiz')).toHaveLength(1)

      await ud.deleteUserData('u1')
      expect(await ud.listUserData('u1')).toEqual([])
      // Other users are untouched by every delete shape.
      expect(await ud.listUserData('u2')).toHaveLength(4)
    })

    it('treats deleting missing data as a no-op', async () => {
      await ud.deleteUserData('ghost', 'default', 'nope')
      await ud.deleteUserData('ghost', 'default')
      await ud.deleteUserData('ghost')
      expect(await ud.listUserData('ghost')).toEqual([])
    })

    it('hides expired entries from get and list (lazy expiry)', async () => {
      await ud.setUserData(entry('u1', 'game', 'board', 'live', { expiresAt: T0 + 60_000 }))
      await ud.setUserData(entry('u1', 'game', 'forever', 'kept'))
      await ud.setUserData(entry('u1', 'game', 'stale', 'born dead', { expiresAt: T0 - 1 }))
      expect(await ud.getUserData('u1', 'game', 'stale')).toBeUndefined()
      expect((await ud.getUserData('u1', 'game', 'board'))?.value).toBe('live')

      vi.setSystemTime(T0 + 60_000) // expiresAt <= now ⇒ absent
      expect(await ud.getUserData('u1', 'game', 'board')).toBeUndefined()
      expect(await ud.listUserData('u1')).toEqual([entry('u1', 'game', 'forever', 'kept')])
      expect(await ud.listUserData('u1', 'game')).toEqual([entry('u1', 'game', 'forever', 'kept')])
    })

    it('rewriting an expired key brings it back with the new value only', async () => {
      await ud.setUserData(entry('u1', 'game', 'board', 'old', { expiresAt: T0 + 1_000 }))
      vi.setSystemTime(T0 + 2_000)
      await ud.setUserData(entry('u1', 'game', 'board', 'new', { updatedAt: T0 + 2_000 }))
      expect(await ud.getUserData('u1', 'game', 'board')).toEqual(entry('u1', 'game', 'board', 'new', { updatedAt: T0 + 2_000 }))
    })

    it('purgeExpiredUserData removes expired entries and keeps live ones', async () => {
      await ud.setUserData(entry('u1', 'game', 'gone', 1, { expiresAt: T0 + 1_000 }))
      await ud.setUserData(entry('u2', 'game', 'gone', 2, { expiresAt: T0 + 1_000 }))
      await ud.setUserData(entry('u1', 'game', 'live', 3, { expiresAt: T0 + 60_000 }))
      await ud.setUserData(entry('u1', 'default', 'forever', 4))
      expect(await ud.purgeExpiredUserData(T0)).toBe(0) // nothing expired yet

      vi.setSystemTime(T0 + 5_000)
      const purged = await ud.purgeExpiredUserData()
      expect(purged).toBeGreaterThanOrEqual(0) // stores with native TTL report 0
      expect(purged).toBeLessThanOrEqual(2)
      expect(sorted(await ud.listUserData('u1'))).toEqual([
        entry('u1', 'default', 'forever', 4),
        entry('u1', 'game', 'live', 3, { expiresAt: T0 + 60_000 }),
      ])
      expect(await ud.listUserData('u2')).toEqual([])
      expect(await ud.purgeExpiredUserData()).toBe(0) // idempotent
    })

    it('returns independent copies of stored values', async () => {
      await ud.setUserData(entry('u1', 'default', 'profile', { tags: ['a'] }))
      const first = await ud.getUserData('u1', 'default', 'profile')
      ;(first?.value as { tags: string[] }).tags.push('mutated')
      const listed = await ud.listUserData('u1')
      ;(listed[0]?.value as { tags: string[] }).tags.push('mutated too')
      expect((await ud.getUserData('u1', 'default', 'profile'))?.value).toEqual({ tags: ['a'] })
    })

    it('stores large values without truncation', async () => {
      const big = 'x'.repeat(100_000)
      await ud.setUserData(entry('u1', 'default', 'big', { big }))
      expect((await ud.getUserData('u1', 'default', 'big'))?.value).toEqual({ big })
    })
  })
}
