/**
 * PostgresStore — unit tests (v2 IStore). Hermetic: an in-memory FakePool
 * stands in for pg (injected via `pool`, or via the mocked 'pg' module for
 * the own-pool lifecycle path). No network, no real PostgreSQL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PostgresStore } from '../src/PostgresStore.js'
import { FakePool } from './fakePool.js'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'

// Mock the 'pg' module so `new PostgresStore({ connectionString })` (no
// injected pool) builds a FakePool instead of opening a real socket.
vi.mock('pg', async () => {
  const { FakePool } = await import('./fakePool.js')
  return { Pool: FakePool }
})

const msg = (chatId: string, id: string, body: string, ts: number, extra?: Partial<StoredMessage>): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false, ...extra,
})

describe('PostgresStore', () => {
  let fake: FakePool
  let store: PostgresStore

  beforeEach(async () => {
    fake = new FakePool()
    store = new PostgresStore({ pool: fake })
    await store.start() // creates the schema on the fake (injected pool = caller-managed)
  })
  afterEach(async () => { await store.stop() })

  it('creates the six tables (with prefix) on start', () => {
    for (const t of ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors']) {
      expect(fake.tables.has(t)).toBe(true)
    }
  })

  it('saves and retrieves a message (JSONB roundtrip, incl. raw payload)', async () => {
    const original = msg('user@s.whatsapp.net', 'msg1', 'hello', 1700000000000, {
      raw: { nested: { ok: true, tags: ['a', 'b'] } },
    })
    await store.saveMessage(original)
    const got = await store.getMessage({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
    expect(got).toEqual(original)
    expect(got?.ref).toEqual({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
  })

  it('returns undefined for missing message', async () => {
    expect(await store.getMessage({ id: 'nope', chatId: 'x@s.whatsapp.net' })).toBeUndefined()
  })

  it('upserts messages on duplicate ref (save is an idempotent update)', async () => {
    await store.saveMessage(msg('c@s.whatsapp.net', 'm1', 'v1', 10))
    await store.saveMessage(msg('c@s.whatsapp.net', 'm1', 'v2', 20))
    const all = await store.getMessagesByChat('c@s.whatsapp.net')
    expect(all).toHaveLength(1)
    expect(all[0].body).toBe('v2')
    expect(all[0].timestamp).toBe(20)
    expect(await store.getMessage({ id: 'm1', chatId: 'c@s.whatsapp.net' })).toMatchObject({ body: 'v2' })
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

  it('deletes a message', async () => {
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
    expect(listed.map((c) => c.id).sort()).toEqual(['chat@g.us', 'telegram:chat:-100123'])
    await store.deleteChat('chat@g.us')
    expect(await store.listChats()).toHaveLength(1)
    expect(await store.getChat('chat@g.us')).toBeUndefined()
  })

  it('upserts and retrieves contacts', async () => {
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice', phoneNumber: '+123' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice')
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice B.' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice B.')
    await store.upsertContact({ id: 'other@s.whatsapp.net', name: 'Bob' })
    const listed = await store.listContacts()
    expect(listed).toHaveLength(2)
    expect(listed.map((c) => c.id).sort()).toEqual(['other@s.whatsapp.net', 'user@s.whatsapp.net'])
  })

  it('manages checkpoints (nested state survives JSONB)', async () => {
    const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana', opts: [1, 2] }, updatedAt: 1 }
    await store.setCheckpoint('user@s.whatsapp.net', cp)
    await store.setCheckpoint('other@s.whatsapp.net', { flowId: 'buy', step: 0, state: {}, updatedAt: 2 })
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toEqual(cp)
    const listed = await store.listCheckpoints()
    expect(listed.sort()).toEqual([
      ['other@s.whatsapp.net', { flowId: 'buy', step: 0, state: {}, updatedAt: 2 }],
      ['user@s.whatsapp.net', cp],
    ])
    // Upsert in place.
    await store.setCheckpoint('user@s.whatsapp.net', { ...cp, step: 3 })
    expect((await store.getCheckpoint('user@s.whatsapp.net'))?.step).toBe(3)
    await store.clearCheckpoint('user@s.whatsapp.net')
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toBeUndefined()
    expect(await store.listCheckpoints()).toHaveLength(1)
  })

  it('manages AI conversations', async () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello!' }]
    await store.setConversation('chat1', msgs)
    expect(await store.getConversation('chat1')).toEqual(msgs)
    await store.setConversation('chat1', [msgs[0]])
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

  it('namespaces tables under tablePrefix', async () => {
    const scoped = new PostgresStore({ pool: fake, tablePrefix: 'acme_' })
    await scoped.start()
    await scoped.saveMessage(msg('c1', 'm1', 'hi', 5))
    await scoped.upsertChat({ id: 'c1', name: 'C1' })
    expect(fake.tables.has('acme_messages')).toBe(true)
    expect(fake.tables.has('acme_chats')).toBe(true)
    expect((await scoped.getChat('c1'))?.name).toBe('C1')
    // Default-prefixed store sees none of it.
    expect(await store.getChat('c1')).toBeUndefined()
    expect(await store.getMessagesByChat('c1')).toHaveLength(0)
  })

  it('rejects an unsafe tablePrefix', () => {
    expect(() => new PostgresStore({ tablePrefix: 'x; DROP TABLE users;--' })).toThrow(/tablePrefix/)
  })
})

describe('PostgresStore — lifecycle', () => {
  it('creates its own pool, creates the schema once, and ends the pool on stop', async () => {
    const endSpy = vi.spyOn(FakePool.prototype, 'end')
    const querySpy = vi.spyOn(FakePool.prototype, 'query')
    try {
      // No `pool` injected → the mocked 'pg' module supplies a FakePool.
      const store = new PostgresStore({ connectionString: 'postgres://fake:5432/botwa' })
      await store.start()
      const createTables = () =>
        querySpy.mock.calls.filter(([t]) => String(t).startsWith('CREATE TABLE IF NOT EXISTS'))
      expect(createTables()).toHaveLength(6)
      // start() is idempotent while started — schema statements are not repeated.
      await store.start()
      expect(createTables()).toHaveLength(6)
      await store.stop()
      expect(endSpy).toHaveBeenCalledTimes(1)
    } finally {
      endSpy.mockRestore()
      querySpy.mockRestore()
    }
  })

  it('creates a fresh pool again after a stop/start cycle', async () => {
    const store = new PostgresStore()
    await store.start()
    await store.upsertChat({ id: 'c1', name: 'one' })
    await store.stop()
    // A new own pool is built on restart (the previous one was ended).
    await store.start()
    await store.upsertChat({ id: 'c2', name: 'two' })
    expect(await store.getChat('c2')).toMatchObject({ name: 'two' })
    await store.stop()
  })

  it('never ends an injected pool', async () => {
    const fake = new FakePool()
    const store = new PostgresStore({ pool: fake })
    await store.start()
    expect(fake.tables.has('messages')).toBe(true)
    await store.stop()
    expect(fake.ended).toBe(false) // injected = caller-managed
    await store.stop() // double stop is a no-op
    expect(fake.ended).toBe(false)
  })

  it('rejects queries before start when no pool was injected', async () => {
    const store = new PostgresStore()
    await expect(store.getChat('x')).rejects.toThrow(/start/)
    await store.stop() // nothing to end — must not throw
  })
})
