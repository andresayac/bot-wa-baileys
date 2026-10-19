/**
 * MongoStore — user-data (`ctx.user`) specifics: collection layout, indexes,
 * JSON-text values and physical purge. The shared contract is covered by the
 * user-data conformance suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MongoStore } from '../src/MongoStore.js'
import { FakeMongoClient, type FakeMongoCollection } from './fakeMongo.js'

const userDataOf = (fake: FakeMongoClient, dbName = 'botwa', name = 'user_data'): FakeMongoCollection => {
  const collection = fake.dbs.get(dbName)?.collections.get(name)
  if (!collection) throw new Error(`no collection ${dbName}.${name}`)
  return collection as FakeMongoCollection
}

describe('MongoStore — user data', () => {
  let fake: FakeMongoClient
  let store: MongoStore

  beforeEach(async () => {
    fake = new FakeMongoClient()
    store = new MongoStore({ client: fake })
    await store.start()
  })
  afterEach(async () => { await store.stop() })

  it('creates the lookup and expiry indexes on start', () => {
    expect(userDataOf(fake).indexes).toEqual(expect.arrayContaining([{ userId: 1, namespace: 1 }, { expiresAt: 1 }]))
  })

  it('stores one document per entry with a collision-free _id and the value as JSON text', async () => {
    await store.setUserData({ userId: 'a:b', namespace: 'c', key: 'k', value: { 'dotted.key': 1, $dollar: 2 }, updatedAt: 9 })
    await store.setUserData({ userId: 'a', namespace: 'b:c', key: 'k', value: 2, updatedAt: 9 })
    const docs = [...userDataOf(fake).docs.values()]
    expect(docs).toHaveLength(2)
    expect(new Set(docs.map((d) => d._id)).size).toBe(2)
    const first = docs.find((d) => d.userId === 'a:b')
    expect(first).toMatchObject({ namespace: 'c', key: 'k', value: '{"dotted.key":1,"$dollar":2}', expiresAt: null, updatedAt: 9 })
    expect((await store.getUserData('a:b', 'c', 'k'))?.value).toEqual({ 'dotted.key': 1, $dollar: 2 })
  })

  it('honors collectionPrefix', async () => {
    const scoped = new MongoStore({ client: fake, dbName: 'acme', collectionPrefix: 'bot2_' })
    await scoped.start()
    await scoped.setUserData({ userId: 'u1', namespace: 'default', key: 'k', value: 1, updatedAt: 1 })
    expect(userDataOf(fake, 'acme', 'bot2_user_data').docs.size).toBe(1)
    expect(await store.getUserData('u1', 'default', 'k')).toBeUndefined()
  })

  it('purgeExpiredUserData physically deletes only expired documents', async () => {
    const now = Date.now()
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'old', value: 1, expiresAt: now - 10, updatedAt: now })
    await store.setUserData({ userId: 'u2', namespace: 'g', key: 'old', value: 2, expiresAt: now, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'live', value: 3, expiresAt: now + 60_000, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'forever', value: 4, updatedAt: now })
    expect(userDataOf(fake).docs.size).toBe(4) // lazily hidden, still stored
    expect(await store.purgeExpiredUserData(now)).toBe(2)
    expect([...userDataOf(fake).docs.values()].map((d) => d.key).sort()).toEqual(['forever', 'live'])
    expect(await store.purgeExpiredUserData(now)).toBe(0)
  })

  it('purgeExpiredUserData deletes in batches of purgeBatchSize and still removes every expired document', async () => {
    const batched = new MongoStore({ client: fake, purgeBatchSize: 3 })
    await batched.start()
    const now = Date.now()
    for (let i = 0; i < 7; i++) {
      await batched.setUserData({ userId: `u${i}`, namespace: 'g', key: 'old', value: i, expiresAt: now - i, updatedAt: now })
    }
    await batched.setUserData({ userId: 'u1', namespace: 'g', key: 'live', value: 'x', expiresAt: now + 60_000, updatedAt: now })
    await batched.setUserData({ userId: 'u1', namespace: 'g', key: 'forever', value: 'y', updatedAt: now })
    const deleteMany = vi.spyOn(userDataOf(fake), 'deleteMany')
    expect(await batched.purgeExpiredUserData(now)).toBe(7)
    expect(deleteMany).toHaveBeenCalledTimes(3) // 3 + 3 + 1: a short batch means nothing is left
    expect([...userDataOf(fake).docs.values()].map((d) => d.key).sort()).toEqual(['forever', 'live'])
  })

  it('rejects a purgeBatchSize that is not a positive integer', () => {
    for (const purgeBatchSize of [0, -1, 1.5, Number.NaN]) {
      expect(() => new MongoStore({ client: fake, purgeBatchSize })).toThrow(RangeError)
    }
  })
})
