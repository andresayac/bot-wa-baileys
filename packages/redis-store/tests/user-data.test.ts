/**
 * RedisStore — user-data (`ctx.user`) specifics: one key per entry with
 * NATIVE expiry (PX), collision-free key encoding and prefix isolation. The
 * shared contract is covered by the user-data conformance suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RedisStore } from '../src/RedisStore.js'
import { FakeRedisClient } from './fakeRedis.js'

const T0 = Date.UTC(2026, 0, 1)

describe('RedisStore — user data', () => {
  let fake: FakeRedisClient
  let store: RedisStore

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    fake = new FakeRedisClient()
    store = new RedisStore({ client: fake })
    await store.start()
  })
  afterEach(async () => {
    await store.stop()
    vi.useRealTimers()
  })

  const udKeys = () => [...fake.strings.keys()].filter((k) => k.startsWith('botwa:ud:'))

  it('stores one key per entry under {prefix}:ud with encoded segments', async () => {
    await store.setUserData({ userId: 'a:b*', namespace: 'n s', key: 'k?[x]', value: 1, updatedAt: T0 })
    expect(udKeys()).toEqual(['botwa:ud:a%3Ab%2A:n%20s:k%3F%5Bx%5D'])
  })

  it('uses native expiry: PX derived from expiresAt', async () => {
    await store.setUserData({ userId: 'u1', namespace: 'game', key: 'board', value: [1], expiresAt: T0 + 30_000, updatedAt: T0 })
    expect(fake.expires.get('botwa:ud:u1:game:board')).toBe(T0 + 30_000)
    expect(await store.purgeExpiredUserData()).toBe(0) // Redis expires keys itself
    vi.setSystemTime(T0 + 30_000)
    expect(await fake.get('botwa:ud:u1:game:board')).toBeNull() // gone natively, not just hidden
  })

  it('a write without expiresAt clears a previous TTL', async () => {
    await store.setUserData({ userId: 'u1', namespace: 'game', key: 'board', value: 1, expiresAt: T0 + 1_000, updatedAt: T0 })
    await store.setUserData({ userId: 'u1', namespace: 'game', key: 'board', value: 2, updatedAt: T0 })
    expect(fake.expires.has('botwa:ud:u1:game:board')).toBe(false)
  })

  it('an already-expired write deletes the key instead of sending a non-positive PX', async () => {
    await store.setUserData({ userId: 'u1', namespace: 'game', key: 'board', value: 1, updatedAt: T0 })
    const set = vi.spyOn(fake, 'set')
    await store.setUserData({ userId: 'u1', namespace: 'game', key: 'board', value: 2, expiresAt: T0, updatedAt: T0 })
    expect(set).not.toHaveBeenCalled()
    expect(udKeys()).toEqual([])
  })

  it('isolates stores with different prefixes on one Redis', async () => {
    const other = new RedisStore({ client: fake, prefix: 'other' })
    await store.setUserData({ userId: 'u1', namespace: 'default', key: 'k', value: 'mine', updatedAt: T0 })
    await other.setUserData({ userId: 'u1', namespace: 'default', key: 'k', value: 'theirs', updatedAt: T0 })
    await other.deleteUserData('u1')
    expect((await store.getUserData('u1', 'default', 'k'))?.value).toBe('mine')
    expect(await other.listUserData('u1')).toEqual([])
  })

  it('sends no empty DEL when a user or namespace has no data', async () => {
    const del = vi.spyOn(fake, 'del')
    await store.deleteUserData('ghost')
    await store.deleteUserData('ghost', 'default')
    expect(del).not.toHaveBeenCalled()
  })

  it('sends a fractional remaining TTL as an integer PX, rounded up', async () => {
    const set = vi.spyOn(fake, 'set')
    await store.setUserData({ userId: 'u', namespace: 'default', key: 'k', value: 1, updatedAt: T0, expiresAt: T0 + 1500.4 })
    expect(set.mock.calls.at(-1)?.[2]).toEqual({ PX: 1501 })
  })
})
