/**
 * RedisStore — unit tests (v2 IStore). Hermetic: an in-memory fake client
 * stands in for Redis (injected via `client`, or via the mocked 'redis'
 * module for the own-client lifecycle path). No network, no real Redis.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RedisStore } from '../src/RedisStore.js'
import { FakeRedisClient } from './fakeRedis.js'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'

// Mock the 'redis' module so `new RedisStore({ url })` (no injected client)
// builds a fake instead of a real socket. Async factory keeps it hoist-safe.
vi.mock('redis', async () => {
  const { FakeRedisClient } = await import('./fakeRedis.js')
  return { createClient: () => new FakeRedisClient() }
})

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

describe('RedisStore', () => {
  let fake: FakeRedisClient
  let store: RedisStore

  beforeEach(async () => {
    fake = new FakeRedisClient()
    store = new RedisStore({ client: fake })
    await store.start() // no-op for injected clients
  })
  afterEach(async () => { await store.stop() })

  it('saves and retrieves a message', async () => {
    await store.saveMessage(msg('user@s.whatsapp.net', 'msg1', 'hello', 1))
    const got = await store.getMessage({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
    expect(got?.body).toBe('hello')
    expect(got?.ref).toEqual({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
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

  it('deletes a message (item and chat index)', async () => {
    await store.saveMessage(msg('u@s.whatsapp.net', 'del1', 'bye', 1))
    await store.saveMessage(msg('u@s.whatsapp.net', 'keep', 'stay', 2))
    await store.deleteMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })
    expect(await store.getMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })).toBeUndefined()
    const remaining = await store.getMessagesByChat('u@s.whatsapp.net')
    expect(remaining.map((m) => m.ref.id)).toEqual(['keep'])
  })

  it('upserts, lists and deletes chats (ids may contain ":")', async () => {
    await store.upsertChat({ id: 'chat@g.us', name: 'Group', kind: 'group' })
    expect((await store.getChat('chat@g.us'))?.name).toBe('Group')
    await store.upsertChat({ id: 'chat@g.us', name: 'Renamed', kind: 'group' })
    expect((await store.getChat('chat@g.us'))?.name).toBe('Renamed')
    await store.upsertChat({ id: 'telegram:chat:-100123', name: 'TG' })
    const listed = await store.listChats()
    expect(listed).toHaveLength(2)
    // Prefix stripping must survive ":" inside the id.
    expect(listed.map((c) => c.id).sort()).toEqual(['chat@g.us', 'telegram:chat:-100123'])
    await store.deleteChat('chat@g.us')
    expect(await store.listChats()).toHaveLength(1)
    expect(await store.getChat('chat@g.us')).toBeUndefined()
  })

  it('maxMessagesPerChat prunes the oldest messages (ZSET members + item keys)', async () => {
    const capped = new RedisStore({ client: fake, prefix: 'cap', maxMessagesPerChat: 3 })
    for (let i = 0; i < 6; i++) await capped.saveMessage(msg('c1', `m${i}`, `msg ${i}`, 1000 + i))
    const kept = await capped.getMessagesByChat('c1')
    expect(kept.map((m) => m.body)).toEqual(['msg 3', 'msg 4', 'msg 5'])
    // The pruned item keys are gone too (no orphans).
    expect(fake.strings.has('cap:msg:item:c1:m0')).toBe(false)
    expect(fake.strings.has('cap:msg:item:c1:m5')).toBe(true)
    expect(await fake.zCard('cap:msg:c1')).toBe(3)
  })

  it('deleteChat purges the message log (ZSET + items), leaving no orphan keys', async () => {
    const scoped = new RedisStore({ client: fake, prefix: 'acme' })
    await scoped.saveMessage(msg('c1', 'm1', 'hi', 1))
    await scoped.saveMessage(msg('c1', 'm2', 'bye', 2))
    await scoped.upsertChat({ id: 'c1', name: 'C1' })
    expect(fake.zsets.has('acme:msg:c1')).toBe(true)
    expect(fake.strings.has('acme:msg:item:c1:m1')).toBe(true)

    await scoped.deleteChat('c1')

    expect(await scoped.getChat('c1')).toBeUndefined()
    expect(await scoped.getMessagesByChat('c1')).toEqual([])
    // No orphaned keys survive.
    expect(fake.zsets.has('acme:msg:c1')).toBe(false)
    expect(fake.strings.has('acme:msg:item:c1:m1')).toBe(false)
    expect(fake.strings.has('acme:msg:item:c1:m2')).toBe(false)
  })

  it('upserts and retrieves contacts', async () => {
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice')
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice B.' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice B.')
    expect(await store.listContacts()).toHaveLength(1)
  })

  it('manages checkpoints', async () => {
    const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana' }, updatedAt: 1 }
    await store.setCheckpoint('user@s.whatsapp.net', cp)
    const got = await store.getCheckpoint('user@s.whatsapp.net')
    expect(got?.flowId).toBe('register')
    expect(await store.listCheckpoints()).toEqual([['user@s.whatsapp.net', cp]])
    await store.clearCheckpoint('user@s.whatsapp.net')
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toBeUndefined()
    expect(await store.listCheckpoints()).toHaveLength(0)
  })

  it('manages AI conversations', async () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello!' }]
    await store.setConversation('chat1', msgs)
    expect(await store.getConversation('chat1')).toEqual(msgs)
    await store.clearConversation('chat1')
    expect(await store.getConversation('chat1')).toBeUndefined()
  })

  it('manages a delivery cursor', async () => {
    expect(await store.getCursor('tg:updates')).toBeUndefined()
    await store.setCursor('tg:updates', '4242')
    expect(await store.getCursor('tg:updates')).toBe('4242')
  })

  it('namespaces every key under the configured prefix', async () => {
    const scoped = new RedisStore({ client: fake, prefix: 'acme' })
    await scoped.saveMessage(msg('c1', 'm1', 'hi', 5))
    await scoped.upsertChat({ id: 'c1' })
    expect(fake.strings.has('acme:msg:item:c1:m1')).toBe(true)
    expect(fake.zsets.has('acme:msg:c1')).toBe(true)
    expect(fake.strings.has('acme:chat:c1')).toBe(true)
    // Default-prefixed store sees none of it.
    expect(await store.getChat('c1')).toBeUndefined()
  })
})

describe('RedisStore — distributed lock', () => {
  let fake: FakeRedisClient
  let store: RedisStore

  beforeEach(() => {
    fake = new FakeRedisClient()
    store = new RedisStore({ client: fake })
  })

  it('acquires once; a second acquire fails while held', async () => {
    const token = await store.acquireLock('job:42', 10_000)
    expect(token).toBeTypeOf('string')
    expect(await store.acquireLock('job:42', 10_000)).toBeNull()
    // Lock key is namespaced and holds the token.
    expect(fake.strings.get('botwa:lock:job:42')).toBe(token)
  })

  it('releases only with the matching token (compare-and-delete)', async () => {
    const token = await store.acquireLock('job:7', 10_000)
    expect(token).not.toBeNull()
    // Foreign release: rejected, lock stays held.
    expect(await store.releaseLock('job:7', 'not-the-token')).toBe(false)
    expect(await store.acquireLock('job:7', 10_000)).toBeNull()
    // Owner release: succeeds; releasing twice fails.
    expect(await store.releaseLock('job:7', token!)).toBe(true)
    expect(await store.releaseLock('job:7', token!)).toBe(false)
    // Lock is free again.
    expect(await store.acquireLock('job:7', 10_000)).toBeTypeOf('string')
  })

  it('expires the lock after its ttl', async () => {
    expect(await store.acquireLock('job:9', 60_000)).not.toBeNull()
    expect(await store.acquireLock('job:9', 60_000)).toBeNull()
    // Simulate the holder crashing past the TTL.
    fake.expires.set('botwa:lock:job:9', Date.now() - 1)
    expect(await store.acquireLock('job:9', 60_000)).toBeTypeOf('string')
  })

  it('records the PX deadline from ttlMs', async () => {
    const before = Date.now()
    await store.acquireLock('job:ttl', 1500)
    const deadline = fake.expires.get('botwa:lock:job:ttl')
    expect(deadline).toBeGreaterThanOrEqual(before + 1500)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 1500)
  })
})

describe('RedisStore — lifecycle', () => {
  it('creates, connects and quits its own client', async () => {
    const connectSpy = vi.spyOn(FakeRedisClient.prototype, 'connect')
    const quitSpy = vi.spyOn(FakeRedisClient.prototype, 'quit')
    try {
      // No `client` injected → the mocked 'redis' module supplies a fake.
      const store = new RedisStore({ url: 'redis://fake:6379' })
      await store.start()
      expect(connectSpy).toHaveBeenCalledTimes(1)
      // start() is idempotent for an already-open own client.
      await store.start()
      expect(connectSpy).toHaveBeenCalledTimes(1)
      await store.stop()
      expect(quitSpy).toHaveBeenCalledTimes(1)
    } finally {
      connectSpy.mockRestore()
      quitSpy.mockRestore()
    }
  })

  it('never connects or quits an injected client', async () => {
    const fake = new FakeRedisClient() // note: isOpen === false
    const store = new RedisStore({ client: fake })
    await store.start()
    expect(fake.isOpen).toBe(false) // injected = caller-managed
    await store.stop()
    expect(fake.isOpen).toBe(false) // never quit
  })

  it('applies ttl (seconds) to conversation and checkpoint keys only', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake, ttl: 60 })
    await store.setConversation('k', [{ role: 'user', content: 'hi' }])
    await store.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
    await store.setCursor('k', 'v')
    await store.saveMessage(msg('c', 'm', 'body', 1))
    const now = Date.now()
    expect(fake.expires.get('botwa:conv:k')).toBeGreaterThanOrEqual(now + 59_000)
    expect(fake.expires.get('botwa:cp:k')).toBeGreaterThanOrEqual(now + 59_000)
    // Cursors, messages and indexes never expire.
    expect(fake.expires.has('botwa:cursor:k')).toBe(false)
    expect(fake.expires.has('botwa:msg:item:c:m')).toBe(false)
    expect(fake.expires.has('botwa:msg:c')).toBe(false)
  })
})
