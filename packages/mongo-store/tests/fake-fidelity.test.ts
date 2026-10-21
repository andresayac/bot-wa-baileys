/**
 * FakeMongo fidelity — the hermetic fake must behave like the real driver +
 * server on the bug classes MongoStore has hit for real: `$unset`, `limit(0)`
 * meaning "no limit" (and a negative limit its absolute value), cursor
 * modifiers applied as sort → skip → limit whatever the call order, and BSON
 * value handling (Binary vs Buffer per `promoteBuffers`, `undefined` per
 * `ignoreUndefined`, Dates kept, `toJSON` NOT used).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { StoredMessage } from '@botmesh/core'
import { MongoStore, TRIM_DELETE_BATCH } from '../src/MongoStore.js'
import { FakeBinary, FakeMongoClient, FakeMongoCollection } from './fakeMongo.js'

vi.mock('mongodb', async () => {
  const { FakeMongoClient } = await import('./fakeMongo.js')
  return { MongoClient: FakeMongoClient }
})

const msg = (chatId: string, id: string, ts: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body: id, fromMe: false, ...extra,
})

type Doc = { _id: string } & Record<string, unknown>

describe('FakeMongo fidelity', () => {
  let col: FakeMongoCollection<Doc>

  beforeEach(() => {
    col = new FakeMongoCollection<Doc>('t')
  })

  it('applies $unset alongside $set', async () => {
    await col.updateOne({ _id: 'a' }, { $set: { x: 1, y: 2, z: 3 } }, { upsert: true })
    await col.updateOne({ _id: 'a' }, { $set: { x: 9 }, $unset: { y: '' } }, { upsert: true })
    expect(await col.findOne({ _id: 'a' })).toEqual({ _id: 'a', x: 9, z: 3 })
  })

  it('stores undefined as null unless ignoreUndefined (arrays always null)', async () => {
    await col.updateOne({ _id: 'a' }, { $set: { u: undefined, n: { v: undefined }, l: [1, undefined] } }, { upsert: true })
    expect(await col.findOne({ _id: 'a' })).toEqual({ _id: 'a', u: null, n: { v: null }, l: [1, null] })
    await col.updateOne({ _id: 'b' }, { $set: { u: undefined, n: { v: undefined }, l: [1, undefined] } }, { upsert: true, ignoreUndefined: true })
    const b = await col.findOne({ _id: 'b' })
    expect(b).toEqual({ _id: 'b', n: {}, l: [1, null] })
    expect(b && 'u' in b).toBe(false)
  })

  it('limit(0) means no limit and a negative limit means its absolute value', async () => {
    for (let i = 0; i < 5; i++) await col.insertOne({ _id: `d${i}`, n: i })
    expect(await col.find({}).sort({ n: 1 }).limit(0).toArray()).toHaveLength(5)
    expect((await col.find({}).sort({ n: 1 }).limit(-2).toArray()).map((d) => d._id)).toEqual(['d0', 'd1'])
  })

  it('applies sort, then skip, then limit — whatever the call order', async () => {
    for (const n of [3, 1, 4, 0, 2]) await col.insertOne({ _id: `d${n}`, n })
    const docs = await col.find({}).limit(2).skip(1).sort({ n: -1 }).toArray()
    expect(docs.map((d) => d.n)).toEqual([3, 2])
  })

  it('projects { _id: 1 } and matches $in', async () => {
    for (let i = 0; i < 4; i++) await col.insertOne({ _id: `d${i}`, n: i, big: 'x' })
    expect(await col.find({ n: { $in: [1, 3] } }, { projection: { _id: 1 } }).toArray()).toEqual([{ _id: 'd1' }, { _id: 'd3' }])
    expect(await col.deleteMany({ _id: { $in: ['d0', 'd2', 'zz'] } })).toMatchObject({ deletedCount: 2 })
    expect([...col.docs.keys()]).toEqual(['d1', 'd3'])
  })

  it('stores bytes as BSON Binary: Buffer back only with promoteBuffers', async () => {
    const bytes = Buffer.from([0, 1, 255])
    await col.insertOne({ _id: 'a', raw: { b: bytes, u8: new Uint8Array([7]) }, list: [Buffer.from('x')] })
    const plain = await col.findOne({ _id: 'a' }) as unknown as { raw: { b: unknown }; list: unknown[] }
    expect(Buffer.isBuffer(plain.raw.b)).toBe(false)
    expect(plain.raw.b).toBeInstanceOf(FakeBinary)
    expect([...(plain.raw.b as FakeBinary).buffer]).toEqual([0, 1, 255])
    const promoted = await col.findOne({ _id: 'a' }, { promoteBuffers: true }) as unknown as { raw: { b: unknown; u8: unknown }; list: unknown[] }
    expect(Buffer.isBuffer(promoted.raw.b)).toBe(true)
    expect(Buffer.compare(promoted.raw.b as Buffer, bytes)).toBe(0)
    expect(Buffer.isBuffer(promoted.raw.u8)).toBe(true)
    expect(Buffer.isBuffer(promoted.list[0])).toBe(true)
    const [listed] = await col.find({}, { promoteBuffers: true }).toArray() as unknown as Array<{ raw: { b: unknown } }>
    expect(Buffer.isBuffer(listed.raw.b)).toBe(true)
    // Stored bytes are a copy: mutating the input after the write changes nothing.
    bytes[0] = 42
    expect((await col.findOne({ _id: 'a' }, { promoteBuffers: true }) as unknown as { raw: { b: Buffer } }).raw.b[0]).toBe(0)
  })

  it('keeps Dates as Dates and does not call toJSON (BSON is not JSON)', async () => {
    const when = new Date(1_700_000_000_000)
    const custom = { a: 1, toJSON: () => 'json!' }
    await col.insertOne({ _id: 'a', when, custom })
    const got = await col.findOne({ _id: 'a' }) as unknown as { when: unknown; custom: unknown }
    expect(got.when).toBeInstanceOf(Date)
    expect((got.when as Date).getTime()).toBe(when.getTime())
    expect(got.custom).toEqual({ a: 1 }) // functions are not serialized
  })

  it('replaces lone surrogates with U+FFFD (BSON strings are UTF-8) and rejects NUL in keys', async () => {
    await col.insertOne({ _id: 'a', s: 'x\uD83Dy', nul: 'a\u0000b' })
    expect(await col.findOne({ _id: 'a' })).toEqual({ _id: 'a', s: 'x\uFFFDy', nul: 'a\u0000b' })
    await expect(col.insertOne({ _id: 'b', ['k\u0000']: 1 })).rejects.toThrow(/null bytes/)
  })
})

describe('MongoStore on a faithful fake', () => {
  let fake: FakeMongoClient

  beforeEach(() => {
    fake = new FakeMongoClient()
  })

  it('trimChat projects _id and deletes the overflow in one deleteMany', async () => {
    const store = new MongoStore({ client: fake, maxMessagesPerChat: 2 })
    await store.start()
    for (let i = 0; i < 3; i++) await store.saveMessage(msg('c', `m${i}`, 10 + i))
    const deleteOne = vi.spyOn(FakeMongoCollection.prototype, 'deleteOne')
    const deleteMany = vi.spyOn(FakeMongoCollection.prototype, 'deleteMany')
    const find = vi.spyOn(FakeMongoCollection.prototype, 'find')
    try {
      // A late, old message plus the newest: two documents fall out at once.
      await store.saveMessage(msg('c', 'old', 1))
      expect(deleteOne).not.toHaveBeenCalled()
      expect(deleteMany).toHaveBeenCalledTimes(1)
      expect(deleteMany.mock.calls[0]![0]).toEqual({ _id: { $in: ['c:old'] } })
      expect(find.mock.calls[0]![1]).toMatchObject({ projection: { _id: 1 } })
      // Nothing to trim → no delete round trip at all.
      deleteMany.mockClear()
      await store.saveMessage(msg('d', 'only', 1))
      expect(deleteMany).not.toHaveBeenCalled()
    } finally {
      deleteOne.mockRestore()
      deleteMany.mockRestore()
      find.mockRestore()
    }
    expect((await store.getMessagesByChat('c')).map((m) => m.ref.id)).toEqual(['m1', 'm2'])
  })

  it('trimChat deletes a large overflow in bounded chunks (BSON command size limit)', async () => {
    // Turning the cap on for a chat with a long history must not build one
    // giant `$in` (400k ids overflow the 16 MiB command limit on a real server).
    const store = new MongoStore({ client: fake, maxMessagesPerChat: 1 })
    await store.start()
    const backlog = TRIM_DELETE_BATCH * 2 + 5
    const col = fake.db('botwa').collection<Doc>('messages')
    for (let i = 0; i < backlog; i++) {
      await col.insertOne({ _id: `big:h${i}`, chatId: 'big', timestamp: i, msg: msg('big', `h${i}`, i) })
    }
    const deleteMany = vi.spyOn(FakeMongoCollection.prototype, 'deleteMany')
    try {
      await store.saveMessage(msg('big', 'newest', backlog + 1))
      expect(deleteMany).toHaveBeenCalledTimes(3)
      for (const [filter] of deleteMany.mock.calls) {
        const ids = (filter as { _id: { $in: unknown[] } })._id.$in
        expect(ids.length).toBeLessThanOrEqual(TRIM_DELETE_BATCH)
      }
    } finally {
      deleteMany.mockRestore()
    }
    expect((await store.getMessagesByChat('big')).map((m) => m.ref.id)).toEqual(['newest'])
  })

  it('round-trips binary payloads as Buffers through every read path', async () => {
    const store = new MongoStore({ client: fake })
    await store.start()
    const bytes = Buffer.from([9, 8, 7])
    await store.saveMessage(msg('c', 'm', 1, { raw: { mediaKey: bytes } }))
    await store.upsertChat({ id: 'c', raw: { avatar: bytes } })
    await store.upsertContact({ id: 'u', raw: { pic: bytes } })
    await store.setCheckpoint('k', { flowId: 'f', step: 0, state: { blob: bytes }, updatedAt: 1 })
    const isBuf = (v: unknown) => Buffer.isBuffer(v) && Buffer.compare(v, bytes) === 0
    expect(isBuf(((await store.getMessage({ id: 'm', chatId: 'c' }))?.raw as { mediaKey: unknown }).mediaKey)).toBe(true)
    expect(isBuf(((await store.getMessagesByChat('c'))[0]!.raw as { mediaKey: unknown }).mediaKey)).toBe(true)
    expect(isBuf(((await store.getChat('c'))?.raw as { avatar: unknown }).avatar)).toBe(true)
    expect(isBuf(((await store.listChats())[0]!.raw as { avatar: unknown }).avatar)).toBe(true)
    expect(isBuf(((await store.getContact('u'))?.raw as { pic: unknown }).pic)).toBe(true)
    expect(isBuf(((await store.listContacts())[0]!.raw as { pic: unknown }).pic)).toBe(true)
    expect(isBuf((await store.getCheckpoint('k'))?.state.blob)).toBe(true)
    expect(isBuf((await store.listCheckpoints())[0]![1].state.blob)).toBe(true)
  })

  it('an explicit undefined clears the field ($unset), never stores null', async () => {
    const store = new MongoStore({ client: fake })
    await store.start()
    await store.upsertChat({ id: 'c', name: 'A', kind: 'group' })
    await store.upsertChat({ id: 'c', name: 'B', kind: undefined })
    expect(await store.getChat('c')).toEqual({ id: 'c', name: 'B' })
  })
})
