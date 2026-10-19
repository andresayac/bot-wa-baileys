/**
 * MysqlStore — unit tests (v2 IStore). Hermetic: an in-memory fake pool
 * stands in for MySQL (injected via `pool`, or via the mocked 'mysql2/promise'
 * module for the own-pool lifecycle path). No network, no real MySQL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPool } from 'mysql2/promise'
import { MysqlStore } from '../src/MysqlStore.js'
import { FakePool } from './fakePool.js'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'

// Mock 'mysql2/promise' so `new MysqlStore({ uri })` (no injected pool)
// builds a fake pool instead of opening a real connection. Async factory
// keeps it hoist-safe.
vi.mock('mysql2/promise', async () => {
  const { FakePool } = await import('./fakePool.js')
  const { vi } = await import('vitest')
  return { createPool: vi.fn(() => new FakePool()) }
})

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

describe('MysqlStore', () => {
  let fake: FakePool
  let store: MysqlStore

  beforeEach(async () => {
    fake = new FakePool()
    store = new MysqlStore({ pool: fake })
    await store.start() // provisions schema on the injected pool
  })
  afterEach(async () => { await store.stop() })

  it('provisions the six state tables + user_data on start (CREATE TABLE IF NOT EXISTS)', async () => {
    const created = fake.queries.map((q) => q.sql).filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'))
    expect(created).toHaveLength(7)
    for (const name of ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors', 'user_data']) {
      expect(fake.tables.has(name)).toBe(true)
    }
  })

  it('saves and retrieves a message', async () => {
    await store.saveMessage(msg('user@s.whatsapp.net', 'msg1', 'hello', 1))
    const got = await store.getMessage({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
    expect(got?.body).toBe('hello')
    expect(got?.ref).toEqual({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
  })

  it('overwrites an existing message on re-save (upsert by messageKey)', async () => {
    await store.saveMessage(msg('u@s.whatsapp.net', 'm1', 'first', 1))
    await store.saveMessage({ ...msg('u@s.whatsapp.net', 'm1', 'edited', 2), timestamp: 2 })
    expect((await store.getMessage({ id: 'm1', chatId: 'u@s.whatsapp.net' }))?.body).toBe('edited')
    expect(await store.getMessagesByChat('u@s.whatsapp.net')).toHaveLength(1)
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

  it('deletes a message', async () => {
    await store.saveMessage(msg('u@s.whatsapp.net', 'del1', 'bye', 1))
    await store.saveMessage(msg('u@s.whatsapp.net', 'keep', 'stay', 2))
    await store.deleteMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })
    expect(await store.getMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })).toBeUndefined()
    const remaining = await store.getMessagesByChat('u@s.whatsapp.net')
    expect(remaining.map((m) => m.ref.id)).toEqual(['keep'])
  })

  it('upserts, lists and deletes chats', async () => {
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

  it('maxMessagesPerChat prunes the oldest messages beyond the cap', async () => {
    const capped = new MysqlStore({ pool: fake, maxMessagesPerChat: 3 })
    await capped.start()
    for (let i = 0; i < 6; i++) await capped.saveMessage(msg('c@s.whatsapp.net', `m${i}`, `msg ${i}`, 1000 + i))
    const kept = await capped.getMessagesByChat('c@s.whatsapp.net')
    expect(kept.map((m) => m.body)).toEqual(['msg 3', 'msg 4', 'msg 5'])
    await capped.saveMessage(msg('other@s.whatsapp.net', 'o1', 'keep', 1))
    expect(await capped.getMessagesByChat('other@s.whatsapp.net')).toHaveLength(1)
  })

  it('deleteChat purges the chat\'s message log (consistent with MemoryStore)', async () => {
    await store.saveMessage(msg('gone@s.whatsapp.net', 'g1', 'x', 1))
    await store.saveMessage(msg('stays@s.whatsapp.net', 's1', 'y', 2))
    await store.upsertChat({ id: 'gone@s.whatsapp.net' })
    await store.deleteChat('gone@s.whatsapp.net')
    expect(await store.getChat('gone@s.whatsapp.net')).toBeUndefined()
    expect(await store.getMessagesByChat('gone@s.whatsapp.net')).toHaveLength(0)
    expect(await store.getMessagesByChat('stays@s.whatsapp.net')).toHaveLength(1)
  })

  it('upserts and retrieves contacts', async () => {
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice')
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice B.' })
    expect((await store.getContact('user@s.whatsapp.net'))?.name).toBe('Alice B.')
    await store.upsertContact({ id: 'other@s.whatsapp.net', name: 'Bob' })
    expect((await store.listContacts()).map((c) => c.id).sort()).toEqual(['other@s.whatsapp.net', 'user@s.whatsapp.net'])
  })

  it('manages checkpoints', async () => {
    const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana' }, updatedAt: 1 }
    await store.setCheckpoint('user@s.whatsapp.net', cp)
    const got = await store.getCheckpoint('user@s.whatsapp.net')
    expect(got).toEqual(cp)
    expect(await store.listCheckpoints()).toEqual([['user@s.whatsapp.net', cp]])
    // Upsert overwrites.
    await store.setCheckpoint('user@s.whatsapp.net', { ...cp, step: 3 })
    expect((await store.getCheckpoint('user@s.whatsapp.net'))?.step).toBe(3)
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
    await store.setCursor('tg:updates', '4243')
    expect(await store.getCursor('tg:updates')).toBe('4243')
  })

  it('parses JSON columns whether mysql2 returns objects or raw strings', async () => {
    // jsonAsString simulates a TEXT-typed/older-driver reply (raw string).
    const strFake = new FakePool({ jsonAsString: true })
    const strStore = new MysqlStore({ pool: strFake })
    await strStore.start()
    await strStore.saveMessage(msg('c', 'm1', 'hi', 1))
    await strStore.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
    expect((await strStore.getMessage({ id: 'm1', chatId: 'c' }))?.body).toBe('hi')
    expect((await strStore.getCheckpoint('k'))?.flowId).toBe('f')
    await strStore.stop()
  })
})

describe('MysqlStore — tablePrefix', () => {
  it('namespaces every table under the configured prefix', async () => {
    const fake = new FakePool({ tablePrefix: 'acme_' })
    const scoped = new MysqlStore({ pool: fake, tablePrefix: 'acme_' })
    await scoped.start()
    await scoped.saveMessage(msg('c1', 'm1', 'hi', 5))
    await scoped.upsertChat({ id: 'c1' })
    for (const name of ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors']) {
      expect(fake.tables.has(`acme_${name}`)).toBe(true)
      expect(fake.tables.has(name)).toBe(false)
    }
    // Roundtrip through the prefixed tables.
    expect((await scoped.getMessage({ id: 'm1', chatId: 'c1' }))?.body).toBe('hi')
    expect((await scoped.getChat('c1'))?.id).toBe('c1')
    await scoped.stop()
  })

  it('rejects an unsafe tablePrefix', () => {
    expect(() => new MysqlStore({ tablePrefix: 'x; DROP TABLE users;--' })).toThrow(/invalid tablePrefix/)
  })
})

describe('MysqlStore — lifecycle', () => {
  beforeEach(() => { vi.mocked(createPool).mockClear() })

  it('creates its own pool from the uri, provisions schema, and ends it on stop', async () => {
    const store = new MysqlStore({ uri: 'mysql://fake:3306/botwa' })
    await store.start()
    expect(createPool).toHaveBeenCalledTimes(1)
    expect(createPool).toHaveBeenCalledWith('mysql://fake:3306/botwa')
    // start() on an existing pool does not recreate it.
    await store.start()
    expect(createPool).toHaveBeenCalledTimes(1)
    await store.stop()
    // A second stop is a safe no-op (pool already released).
    await store.stop()
    expect(store['pool' as never]).toBeNull()
  })

  it('defaults the uri to mysql://localhost:3306/botwa', async () => {
    const store = new MysqlStore()
    await store.start()
    expect(createPool).toHaveBeenCalledWith('mysql://localhost:3306/botwa')
    await store.stop()
  })

  it('builds a pool config when host/port/user/password/database are given', async () => {
    const store = new MysqlStore({ host: 'db.internal', port: 3307, user: 'bot', password: 'secret', database: 'botwa' })
    await store.start()
    expect(createPool).toHaveBeenCalledWith({ host: 'db.internal', port: 3307, user: 'bot', password: 'secret', database: 'botwa' })
    await store.stop()
  })

  it('never ends an injected pool', async () => {
    const fake = new FakePool()
    const store = new MysqlStore({ pool: fake })
    await store.start()
    await store.stop()
    expect(fake.ended).toBe(false)
    // The caller-owned pool keeps serving after stop().
    await store.upsertChat({ id: 'still-alive' })
    expect((await store.getChat('still-alive'))?.id).toBe('still-alive')
  })

  it('fails fast with a clear error when used before start()', async () => {
    const store = new MysqlStore() // no pool injected, not started
    await expect(store.getMessage({ id: 'm', chatId: 'c' })).rejects.toThrow(/start\(\)/)
  })

  it('logs and swallows pool end() failures on stop', async () => {
    const error = vi.fn()
    const fake = new FakePool()
    // Force a createPool-supplied pool whose end() rejects.
    vi.mocked(createPool).mockImplementationOnce(() => {
      const p = new FakePool()
      p.end = async () => { throw new Error('boom') }
      return p as never
    })
    const store = new MysqlStore({ uri: 'mysql://x', logger: { error } })
    await store.start()
    await expect(store.stop()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(fake.ended).toBe(false) // untouched other fake
  })
})

describe('MysqlStore — options validation', () => {
  it('rejects an invalid maxMessagesPerChat up front (RangeError)', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MysqlStore({ maxMessagesPerChat: bad })).toThrow(RangeError)
    }
  })
})

describe('MysqlStore — legacy schema notice', () => {
  /** FakePool that answers the information_schema probe with the given key-column types. */
  class SchemaPool extends FakePool {
    constructor(private readonly types: Array<[table: string, column: string, type: string | Buffer]> | Error) { super() }
    override async query(sql: string, params?: readonly unknown[]) {
      if (sql.includes('information_schema.COLUMNS')) {
        if (this.types instanceof Error) throw this.types
        return [this.types.map(([t, c, type]) => ({ t, c, type })), []] as Awaited<ReturnType<FakePool['query']>>
      }
      return super.query(sql, params)
    }
  }

  it('warns once, naming the non-binary key columns and the README upgrade section', async () => {
    const warn = vi.fn()
    const store = new MysqlStore({
      pool: new SchemaPool([['messages', 'id', 'varchar'], ['messages', 'chat_id', Buffer.from('varchar')], ['messages', 'msg', 'json'], ['chats', 'id', 'varbinary']]),
      logger: { warn },
    })
    await store.start()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({ columns: ['messages.id', 'messages.chat_id'] })
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/Upgrading tables created by an earlier version/)
  })

  it('falls back to logger.error when there is no warn', async () => {
    const error = vi.fn()
    await new MysqlStore({ pool: new SchemaPool([['cursors', 'key', 'varchar']]), logger: { error } }).start()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('never fails start(): the probe is advisory', async () => {
    const warn = vi.fn()
    await new MysqlStore({ pool: new SchemaPool(new Error('SELECT command denied')), logger: { warn } }).start()
    expect(warn).not.toHaveBeenCalled()
  })
})
