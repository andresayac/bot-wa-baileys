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

describe('RedisStore — record upserts across replicas', () => {
  const chat = (fake: FakeRedisClient, key = 'botwa:chat:c'): unknown => JSON.parse(fake.strings.get(key) ?? 'null')

  it('two stores (replicas) sharing one server never lose each other\'s fields', async () => {
    const fake = new FakeRedisClient()
    const a = new RedisStore({ client: fake })
    const b = new RedisStore({ client: fake })
    await a.upsertChat({ id: 'c', name: 'Original' })
    // Each replica only chains its OWN upserts, so these interleave on the server.
    await Promise.all([
      a.upsertChat({ id: 'c', name: 'Renamed', kind: 'group' }),
      b.upsertChat({ id: 'c', lastMessageAt: 7 }),
      a.upsertChat({ id: 'c', updatedAt: 8 }),
      b.upsertChat({ id: 'c', botId: 'bot-3' }),
    ])
    expect(chat(fake)).toEqual({ id: 'c', name: 'Renamed', kind: 'group', lastMessageAt: 7, updatedAt: 8, botId: 'bot-3' })

    await Promise.all([
      a.upsertContact({ id: 'u', name: 'Ana' }),
      b.upsertContact({ id: 'u', username: 'ana' }),
      b.upsertContact({ id: 'u', phoneNumber: '+57' }),
    ])
    expect(await a.getContact('u')).toEqual({ id: 'u', name: 'Ana', username: 'ana', phoneNumber: '+57' })
  })

  it('an explicit undefined removes the field (MemoryStore semantics), also under contention', async () => {
    const fake = new FakeRedisClient()
    const a = new RedisStore({ client: fake })
    const b = new RedisStore({ client: fake })
    await a.upsertContact({ id: 'u', name: 'Ana', username: 'ana', phoneNumber: '+1' })
    await Promise.all([a.upsertContact({ id: 'u', phoneNumber: undefined }), b.upsertContact({ id: 'u', name: 'Ana B.' })])
    const stored = JSON.parse(fake.strings.get('botwa:contact:u') ?? 'null') as Record<string, unknown>
    expect(stored).toEqual({ id: 'u', name: 'Ana B.', username: 'ana' })
    expect('phoneNumber' in stored).toBe(false)
  })

  it('a write that lands between the read and the write is merged, not overwritten', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake })
    await store.upsertChat({ id: 'c', name: 'A' })
    const realGet = fake.get.bind(fake)
    let raced = false
    vi.spyOn(fake, 'get').mockImplementation(async (key) => {
      const value = await realGet(key)
      if (!raced && key === 'botwa:chat:c') {
        raced = true // another process writes right after our read
        await fake.set(key, JSON.stringify({ id: 'c', name: 'A', kind: 'group' }))
      }
      return value
    })
    await store.upsertChat({ id: 'c', lastMessageAt: 1 })
    expect(chat(fake)).toEqual({ id: 'c', name: 'A', kind: 'group', lastMessageAt: 1 })
  })

  it('gives up with an error instead of spinning forever under endless contention', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake })
    await store.upsertChat({ id: 'c', name: 'A' })
    const realGet = fake.get.bind(fake)
    let n = 0
    const spy = vi.spyOn(fake, 'get').mockImplementation(async (key) => {
      const value = await realGet(key)
      await fake.set(key, JSON.stringify({ id: 'c', n: ++n }))
      return value
    })
    await expect(store.upsertChat({ id: 'c', kind: 'group' })).rejects.toThrow(/contention/)
    // A failed upsert does not poison the next one.
    spy.mockRestore()
    await store.upsertChat({ id: 'c', kind: 'dm' })
    expect((chat(fake) as { kind?: string }).kind).toBe('dm')
  })

  it('keeps the merged record byte-exact (no lossy server-side JSON re-encoding)', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake })
    const raw = { arr: [], obj: {}, float: 0.1 + 0.2, big: Number.MAX_SAFE_INTEGER, url: 'https://x/y' }
    await store.upsertChat({ id: 'c', raw })
    await store.upsertChat({ id: 'c', name: 'n' })
    expect(fake.strings.get('botwa:chat:c')).toBe(JSON.stringify({ id: 'c', raw, name: 'n' }))
  })
})

describe('RedisStore — glob metacharacters in the prefix (hermetic)', () => {
  it('listings stay inside the prefix even when it contains glob metacharacters', async () => {
    const fake = new FakeRedisClient()
    const bracket = new RedisStore({ client: fake, prefix: 'base[1]' })
    const sibling = new RedisStore({ client: fake, prefix: 'base1' }) // matched by the unescaped pattern `base[1]:chat:*`
    const star = new RedisStore({ client: fake, prefix: 'base*' })
    const other = new RedisStore({ client: fake, prefix: 'base-other' }) // matched by the unescaped pattern `base*:chat:*`
    const slash = new RedisStore({ client: fake, prefix: 'base\\' })
    const query = new RedisStore({ client: fake, prefix: 'bas?' })

    for (const [store, tag] of [[bracket, 'bracket'], [sibling, 'sibling'], [star, 'star'], [other, 'other'], [slash, 'slash'], [query, 'query']] as const) {
      await store.upsertChat({ id: `chat-${tag}` })
      await store.upsertContact({ id: `user-${tag}` })
      await store.setCheckpoint(`cp-${tag}`, { flowId: tag, step: 0, state: {}, updatedAt: 0 })
    }

    expect((await bracket.listChats()).map((c) => c.id)).toEqual(['chat-bracket'])
    expect((await bracket.listContacts()).map((c) => c.id)).toEqual(['user-bracket'])
    expect((await bracket.listCheckpoints()).map(([k]) => k)).toEqual(['cp-bracket'])
    expect((await star.listChats()).map((c) => c.id)).toEqual(['chat-star'])
    expect((await star.listContacts()).map((c) => c.id)).toEqual(['user-star'])
    expect((await star.listCheckpoints()).map(([k]) => k)).toEqual(['cp-star'])
    expect((await sibling.listChats()).map((c) => c.id)).toEqual(['chat-sibling'])
    expect((await slash.listChats()).map((c) => c.id)).toEqual(['chat-slash'])
    expect((await query.listChats()).map((c) => c.id)).toEqual(['chat-query'])
  })

  it('a glob-hostile prefix only scans and deletes its own user-data keys', async () => {
    const fake = new FakeRedisClient()
    const hostile = new RedisStore({ client: fake, prefix: 'ud[1]' })
    const neighbour = new RedisStore({ client: fake, prefix: 'ud1' })
    await hostile.setUserData({ userId: 'u', namespace: 'default', key: 'a', value: 1, updatedAt: 1 })
    await neighbour.setUserData({ userId: 'u', namespace: 'default', key: 'b', value: 2, updatedAt: 1 })
    expect((await hostile.listUserData('u')).map((e) => e.key)).toEqual(['a'])
    await hostile.deleteUserData('u')
    expect((await neighbour.listUserData('u')).map((e) => e.key)).toEqual(['b'])
    expect(await hostile.listUserData('u')).toEqual([])
  })

  it('the fake really treats an unescaped bracket prefix as a class (the bug the escaping prevents)', async () => {
    const fake = new FakeRedisClient()
    await fake.set('base1:chat:x', '{}')
    expect(await fake.keys('base[1]:chat:*')).toEqual(['base1:chat:x'])
    expect(await fake.keys('base\\[1\\]:chat:*')).toEqual([])
  })
})

describe('RedisStore — sessionTtl (duration, same unit convention as core)', () => {
  const remaining = (fake: FakeRedisClient, key: string): number => (fake.expires.get(key) ?? 0) - Date.now()

  it('takes a duration string and applies it to checkpoints and AI history', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake, prefix: 'st', sessionTtl: '1m' })
    await store.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
    await store.setConversation('k', [{ role: 'user', content: 'hi' }])
    for (const key of ['st:cp:k', 'st:conv:k']) {
      expect(remaining(fake, key)).toBeGreaterThan(55_000)
      expect(remaining(fake, key)).toBeLessThanOrEqual(60_000)
    }
  })

  it('takes a number as milliseconds (unlike the deprecated `ttl`, in seconds)', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake, prefix: 'st', sessionTtl: 60_000 })
    await store.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
    expect(remaining(fake, 'st:cp:k')).toBeGreaterThan(55_000)
    expect(remaining(fake, 'st:cp:k')).toBeLessThanOrEqual(60_000)
  })

  it('the deprecated `ttl` (seconds) keeps working', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake, prefix: 'st', ttl: 60 })
    await store.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
    expect(remaining(fake, 'st:cp:k')).toBeGreaterThan(55_000)
  })

  it('rejects invalid values and both options at once', () => {
    const fake = new FakeRedisClient()
    expect(() => new RedisStore({ client: fake, sessionTtl: 'soon' })).toThrow(/Invalid duration/)
    expect(() => new RedisStore({ client: fake, sessionTtl: 0 })).toThrow(RangeError)
    expect(() => new RedisStore({ client: fake, sessionTtl: '1m', ttl: 60 })).toThrow(RangeError)
  })
})
