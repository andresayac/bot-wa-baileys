/**
 * MongoStore — unit tests (v2 IStore). Hermetic: an in-memory fake client
 * stands in for MongoDB (injected via `client`, or via the mocked 'mongodb'
 * module for the own-client lifecycle path). No network, no real MongoDB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MongoStore } from '../src/MongoStore.js'
import { FakeMongoClient, FakeMongoCollection } from './fakeMongo.js'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'

// Mock the 'mongodb' module so `new MongoStore({ url })` (no injected client)
// builds a fake instead of a real socket. Async factory keeps it hoist-safe.
vi.mock('mongodb', async () => {
  const { FakeMongoClient } = await import('./fakeMongo.js')
  return { MongoClient: FakeMongoClient }
})

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

const messagesOf = (fake: FakeMongoClient, dbName = 'botwa'): FakeMongoCollection => {
  const db = fake.dbs.get(dbName)
  if (!db) throw new Error(`no db ${dbName}`)
  return db.collections.get('messages') as FakeMongoCollection
}

describe('MongoStore', () => {
  let fake: FakeMongoClient
  let store: MongoStore

  beforeEach(async () => {
    fake = new FakeMongoClient()
    store = new MongoStore({ client: fake })
    await store.start() // no-op connect for injected clients; creates the index
  })
  afterEach(async () => { await store.stop() })

  it('saves and retrieves a message', async () => {
    const saved = msg('user@s.whatsapp.net', 'msg1', 'hello', 1)
    await store.saveMessage(saved)
    const got = await store.getMessage({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
    expect(got).toEqual(saved)
    expect(got?.ref).toEqual({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
  })

  it('stores the message doc under messageKey with chat/timestamp metadata', async () => {
    await store.saveMessage(msg('c@s.whatsapp.net', 'm1', 'hi', 42))
    const doc = messagesOf(fake).docs.get('c@s.whatsapp.net:m1')
    expect(doc).toMatchObject({ _id: 'c@s.whatsapp.net:m1', chatId: 'c@s.whatsapp.net', timestamp: 42 })
    expect((doc?.msg as StoredMessage).body).toBe('hi')
  })

  it('updates a message in place when re-saved with the same ref (upsert)', async () => {
    await store.saveMessage(msg('c@s.whatsapp.net', 'm1', 'v1', 1))
    await store.saveMessage(msg('c@s.whatsapp.net', 'm1', 'v2', 2))
    expect((await store.getMessage({ id: 'm1', chatId: 'c@s.whatsapp.net' }))?.body).toBe('v2')
    expect(await store.getMessagesByChat('c@s.whatsapp.net')).toHaveLength(1)
  })

  it('returns undefined for missing message', async () => {
    expect(await store.getMessage({ id: 'nope', chatId: 'x@s.whatsapp.net' })).toBeUndefined()
  })

  it('lists messages by chat in ascending order (most recent window)', async () => {
    for (let i = 0; i < 5; i++) await store.saveMessage(msg('chat@s.whatsapp.net', `m${i}`, `msg ${i}`, 1000 + i))
    const msgs = await store.getMessagesByChat('chat@s.whatsapp.net', 3)
    expect(msgs).toHaveLength(3)
    expect(msgs[0].body).toBe('msg 2')
    expect(msgs[2].body).toBe('msg 4')
    // Unbounded read returns everything, oldest first.
    const all = await store.getMessagesByChat('chat@s.whatsapp.net')
    expect(all.map((m) => m.body)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
  })

  it('keeps per-chat logs isolated', async () => {
    await store.saveMessage(msg('a@s.whatsapp.net', 'a1', 'in a', 1))
    await store.saveMessage(msg('b@s.whatsapp.net', 'b1', 'in b', 2))
    expect(await store.getMessagesByChat('a@s.whatsapp.net')).toHaveLength(1)
    expect(await store.getMessagesByChat('b@s.whatsapp.net')).toHaveLength(1)
  })

  it('deletes a message without touching its neighbors', async () => {
    await store.saveMessage(msg('u@s.whatsapp.net', 'del1', 'bye', 1))
    await store.saveMessage(msg('u@s.whatsapp.net', 'keep', 'stay', 2))
    await store.deleteMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })
    expect(await store.getMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })).toBeUndefined()
    const remaining = await store.getMessagesByChat('u@s.whatsapp.net')
    expect(remaining.map((m) => m.ref.id)).toEqual(['keep'])
    // Deleting a message that does not exist is a no-op.
    await expect(store.deleteMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })).resolves.toBeUndefined()
  })

  it('upserts, lists and deletes chats (ids may contain ":")', async () => {
    await store.upsertChat({ id: 'chat@g.us', name: 'Group', kind: 'group' })
    expect((await store.getChat('chat@g.us'))?.name).toBe('Group')
    await store.upsertChat({ id: 'chat@g.us', name: 'Renamed', kind: 'group' })
    expect(await store.getChat('chat@g.us')).toEqual({ id: 'chat@g.us', name: 'Renamed', kind: 'group' })
    await store.upsertChat({ id: 'telegram:chat:-100123', name: 'TG' })
    const listed = await store.listChats()
    expect(listed).toHaveLength(2)
    expect(listed.map((c) => c.id).sort()).toEqual(['chat@g.us', 'telegram:chat:-100123'])
    // No _id leaks into the returned shape.
    expect(listed.every((c) => !('_id' in c))).toBe(true)
    await store.deleteChat('chat@g.us')
    expect(await store.listChats()).toHaveLength(1)
    expect(await store.getChat('chat@g.us')).toBeUndefined()
  })

  it('maxMessagesPerChat prunes the oldest messages beyond the cap', async () => {
    const capped = new MongoStore({ client: fake, maxMessagesPerChat: 3 })
    await capped.start()
    for (let i = 0; i < 6; i++) await capped.saveMessage(msg('c@s.whatsapp.net', `m${i}`, `msg ${i}`, 1000 + i))
    const kept = await capped.getMessagesByChat('c@s.whatsapp.net')
    expect(kept.map((m) => m.body)).toEqual(['msg 3', 'msg 4', 'msg 5'])
    await capped.saveMessage(msg('other@s.whatsapp.net', 'o1', 'keep', 1))
    expect(await capped.getMessagesByChat('other@s.whatsapp.net')).toHaveLength(1)
  })

  it('deleteChat removes the chat record AND purges its message log (consistent with MemoryStore)', async () => {
    await store.saveMessage(msg('gone@s.whatsapp.net', 'g1', 'x', 1))
    await store.saveMessage(msg('stays@s.whatsapp.net', 's1', 'y', 2))
    await store.deleteChat('gone@s.whatsapp.net')
    expect(await store.getChat('gone@s.whatsapp.net')).toBeUndefined()
    // The deleted chat's messages are purged; other chats' logs are untouched.
    expect(await store.getMessagesByChat('gone@s.whatsapp.net')).toHaveLength(0)
    expect(await store.getMessagesByChat('stays@s.whatsapp.net')).toHaveLength(1)
  })

  it('upserts and retrieves contacts', async () => {
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice')
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice B.', username: 'aliceb' })
    expect(await store.getContact('user@s.whatsapp.net')).toEqual({ id: 'user@s.whatsapp.net', name: 'Alice B.', username: 'aliceb' })
    expect(await store.listContacts()).toHaveLength(1)
  })

  it('manages checkpoints', async () => {
    const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana' }, updatedAt: 1 }
    await store.setCheckpoint('user@s.whatsapp.net', cp)
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toEqual(cp)
    // Overwrite in place.
    const cp2: FlowCheckpoint = { ...cp, step: 3 }
    await store.setCheckpoint('user@s.whatsapp.net', cp2)
    expect((await store.getCheckpoint('user@s.whatsapp.net'))?.step).toBe(3)
    expect(await store.listCheckpoints()).toEqual([['user@s.whatsapp.net', cp2]])
    await store.clearCheckpoint('user@s.whatsapp.net')
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toBeUndefined()
    expect(await store.listCheckpoints()).toHaveLength(0)
  })

  it('manages AI conversations', async () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello!' }]
    await store.setConversation('chat1', msgs)
    expect(await store.getConversation('chat1')).toEqual(msgs)
    // Replacing overwrites the whole history.
    await store.setConversation('chat1', [{ role: 'user', content: 'fresh' }])
    expect(await store.getConversation('chat1')).toHaveLength(1)
    await store.clearConversation('chat1')
    expect(await store.getConversation('chat1')).toBeUndefined()
  })

  it('manages a delivery cursor', async () => {
    expect(await store.getCursor('tg:updates')).toBeUndefined()
    await store.setCursor('tg:updates', '4242')
    expect(await store.getCursor('tg:updates')).toBe('4242')
    await store.setCursor('tg:updates', '4243')
    expect(await store.getCursor('tg:updates')).toBe('4243')
  })

  it('honors dbName and collectionPrefix', async () => {
    const scoped = new MongoStore({ client: fake, dbName: 'acme', collectionPrefix: 'bot2_' })
    await scoped.saveMessage(msg('c1', 'm1', 'hi', 5))
    await scoped.upsertChat({ id: 'c1' })
    await scoped.setCursor('k', 'v')
    const db = fake.dbs.get('acme')
    expect(db).toBeDefined()
    expect(db?.collections.get('bot2_messages')?.docs.has('c1:m1')).toBe(true)
    expect(db?.collections.get('bot2_chats')?.docs.has('c1')).toBe(true)
    expect(db?.collections.get('bot2_cursors')?.docs.has('k')).toBe(true)
    // Default-scoped store sees none of it.
    expect(await store.getChat('c1')).toBeUndefined()
    expect(await store.getCursor('k')).toBeUndefined()
  })

  it('creates the messages compound index on start (with _id as the tie-break key)', async () => {
    expect(messagesOf(fake).indexes).toContainEqual({ chatId: 1, timestamp: 1, _id: 1 })
  })

  it('breaks timestamp ties by message key, like the SQL stores (window and trim agree)', async () => {
    // Same timestamp, inserted out of key order: the window must not depend on insertion order.
    for (const id of ['b', 'a', 'c']) await store.saveMessage(msg('tie@x', id, id, 5))
    expect((await store.getMessagesByChat('tie@x', 2)).map((m) => m.ref.id)).toEqual(['b', 'c'])
    expect((await store.getMessagesByChat('tie@x')).map((m) => m.ref.id)).toEqual(['a', 'b', 'c'])

    const capped = new MongoStore({ client: fake, collectionPrefix: 'cap_', maxMessagesPerChat: 2 })
    await capped.start()
    for (const id of ['b', 'a', 'c']) await capped.saveMessage(msg('tie@x', id, id, 5))
    expect((await capped.getMessagesByChat('tie@x')).map((m) => m.ref.id)).toEqual(['b', 'c'])
  })
})

describe('MongoStore — lifecycle', () => {
  it('creates, connects and closes its own client', async () => {
    const connectSpy = vi.spyOn(FakeMongoClient.prototype, 'connect')
    const closeSpy = vi.spyOn(FakeMongoClient.prototype, 'close')
    const indexSpy = vi.spyOn(FakeMongoCollection.prototype, 'createIndex')
    try {
      // No `client` injected → the mocked 'mongodb' module supplies a fake.
      const store = new MongoStore({ url: 'mongodb://fake:27017', dbName: 'lifecycle' })
      await store.start()
      expect(connectSpy).toHaveBeenCalledTimes(1)
      expect(indexSpy).toHaveBeenCalledWith({ chatId: 1, timestamp: 1, _id: 1 })
      // start() is idempotent for an already-connected own client.
      await store.start()
      expect(connectSpy).toHaveBeenCalledTimes(1)
      await store.stop()
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      connectSpy.mockRestore()
      closeSpy.mockRestore()
      indexSpy.mockRestore()
    }
  })

  it('never connects or closes an injected client', async () => {
    const fake = new FakeMongoClient() // note: connected === false
    const store = new MongoStore({ client: fake })
    await store.start()
    expect(fake.connected).toBe(false) // injected = caller-managed
    await store.stop()
    expect(fake.closeCount).toBe(0) // never closed
  })
})

describe('MongoStore — options validation', () => {
  it('rejects an invalid maxMessagesPerChat up front (RangeError)', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MongoStore({ client: new FakeMongoClient(), maxMessagesPerChat: bad })).toThrow(RangeError)
    }
  })
})
