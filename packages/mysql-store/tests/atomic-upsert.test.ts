/**
 * MysqlStore — upsertChat/upsertContact are an atomic shallow merge
 * (`{ ...existing, ...patch }`, exactly MemoryStore's semantics) even when
 * several connections/processes upsert the same record at once. Hermetic: the
 * FakePool models dedicated connections, row locks (SELECT ... FOR UPDATE),
 * ROLLBACK and injected server errors. tests/integration.test.ts proves the
 * same against a real MySQL with many clients.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryStore } from '@botmesh/core'
import type { StoredChat, StoredContact } from '@botmesh/core'
import { MysqlStore } from '../src/MysqlStore.js'
import { FakePool, deadlockError, mysqlError } from './fakePool.js'

const chat = (fields: Record<string, unknown>): StoredChat => fields as unknown as StoredChat
const contact = (fields: Record<string, unknown>): StoredContact => fields as unknown as StoredContact

describe('MysqlStore — atomic upsert merge', () => {
  let fake: FakePool
  let a: MysqlStore
  let b: MysqlStore

  beforeEach(async () => {
    fake = new FakePool()
    // Two stores on one database: two bot replicas.
    a = new MysqlStore({ pool: fake })
    b = new MysqlStore({ pool: fake })
    await a.start()
    await b.start()
  })

  const statements = (): string[] => fake.queries.map((q) => q.sql.replace(/\s+/g, ' '))

  it('concurrent partial upserts of a NEW and an EXISTING record keep every field (chats and contacts)', async () => {
    await a.upsertChat({ id: 'existing', name: 'base' })
    await a.upsertContact({ id: 'existing', name: 'base' })
    for (const id of ['fresh', 'existing']) {
      const writes: Array<Promise<void>> = []
      const expected: Record<string, number> = {}
      for (let i = 0; i < 40; i++) {
        const store = i % 2 === 0 ? a : b
        writes.push(store.upsertChat(chat({ id, [`f${i}`]: i })), store.upsertContact(contact({ id, [`f${i}`]: i })))
        expected[`f${i}`] = i
      }
      await Promise.all(writes)
      const base = id === 'existing' ? { name: 'base' } : {}
      expect(await b.getChat(id)).toEqual({ id, ...base, ...expected })
      expect(await b.getContact(id)).toEqual({ id, ...base, ...expected })
    }
    expect(fake.checkedOut).toBe(0)
  })

  it('matches MemoryStore exactly: explicit undefined drops a key, null is kept, nested values are replaced', async () => {
    const memory = new MemoryStore()
    const steps: StoredChat[] = [
      chat({ id: 'c', name: 'Group', kind: 'group', raw: { a: { b: 1 }, keep: true }, updatedAt: 1 }),
      chat({ id: 'c', name: undefined, raw: { a: null }, updatedAt: null }),
      chat({ id: 'c', lastMessageAt: 5 }),
    ]
    for (const step of steps) {
      await memory.upsertChat(step)
      await a.upsertChat(step)
    }
    const got = await a.getChat('c')
    expect(got).toEqual({ id: 'c', kind: 'group', raw: { a: null }, updatedAt: null, lastMessageAt: 5 })
    expect(got).toEqual(await memory.getChat('c'))
    expect(Object.keys(got ?? {}).sort()).toEqual(['id', 'kind', 'lastMessageAt', 'raw', 'updatedAt'])

    await a.upsertContact({ id: 'u', name: 'Ana', username: 'ana' })
    await a.upsertContact(contact({ id: 'u', username: undefined, phoneNumber: null }))
    expect(await a.getContact('u')).toEqual({ id: 'u', name: 'Ana', phoneNumber: null })
    expect(Object.keys((await a.getContact('u')) ?? {})).not.toContain('username')
  })

  it('merges inside a transaction that locks the row (SELECT ... FOR UPDATE) and releases the connection', async () => {
    await a.upsertChat({ id: 'c', name: 'one' })
    fake.queries.length = 0
    await a.upsertChat({ id: 'c', kind: 'group' })
    expect(statements()).toEqual([
      'START TRANSACTION',
      'SELECT data FROM `chats` WHERE id = ? FOR UPDATE',
      'UPDATE `chats` SET data = ? WHERE id = ?',
      'COMMIT',
    ])
    expect(fake.queries.every((q) => q.conn === fake.connections.at(-1))).toBe(true)
    expect(fake.checkedOut).toBe(0)
  })

  it('creates a missing row without holding a lock while inserting, then merges over whatever is there', async () => {
    await a.upsertContact({ id: 'new', name: 'N' })
    expect(statements().slice(-8)).toEqual([
      'START TRANSACTION',
      'SELECT data FROM `contacts` WHERE id = ? FOR UPDATE',
      'ROLLBACK',
      'INSERT INTO `contacts` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
      'START TRANSACTION',
      'SELECT data FROM `contacts` WHERE id = ? FOR UPDATE',
      'UPDATE `contacts` SET data = ? WHERE id = ?',
      'COMMIT',
    ])
    expect(await a.getContact('new')).toEqual({ id: 'new', name: 'N' })
  })

  it('retries a deadlock victim and still merges', async () => {
    await a.upsertChat({ id: 'c', name: 'one' })
    fake.failNext(/^UPDATE `chats`/, deadlockError())
    await a.upsertChat({ id: 'c', kind: 'group' })
    expect(await a.getChat('c')).toEqual({ id: 'c', name: 'one', kind: 'group' })
    expect(fake.checkedOut).toBe(0)
  })

  it('gives up after repeated deadlocks with the server error', async () => {
    await a.upsertChat({ id: 'c', name: 'one' })
    for (let i = 0; i < 10; i++) fake.failNext(/^UPDATE `chats`/, deadlockError())
    await expect(a.upsertChat({ id: 'c', kind: 'group' })).rejects.toMatchObject({ errno: 1213 })
    expect(await a.getChat('c')).toEqual({ id: 'c', name: 'one' })
    expect(fake.checkedOut).toBe(0)
  })

  it('rolls back and releases the connection when a statement fails, leaving the record untouched', async () => {
    await a.upsertChat({ id: 'c', name: 'one' })
    fake.failNext(/^COMMIT$/, mysqlError('ER_QUERY_INTERRUPTED', 1317, '70100', 'Query execution was interrupted'))
    await expect(a.upsertChat({ id: 'c', kind: 'group' })).rejects.toMatchObject({ errno: 1317 })
    expect(statements().at(-1)).toBe('ROLLBACK')
    expect(await a.getChat('c')).toEqual({ id: 'c', name: 'one' })
    expect(fake.checkedOut).toBe(0)
    // No lock leaked: another replica can still write the row.
    await b.upsertChat({ id: 'c', kind: 'dm' })
    expect(await a.getChat('c')).toEqual({ id: 'c', name: 'one', kind: 'dm' })
  })

  it('destroys (never reuses) a connection whose ROLLBACK failed', async () => {
    await a.upsertChat({ id: 'c', name: 'one' })
    fake.failNext(/^UPDATE `chats`/, mysqlError('PROTOCOL_CONNECTION_LOST', -1, '', 'Connection lost'))
    fake.failNext(/^ROLLBACK$/, mysqlError('PROTOCOL_CONNECTION_LOST', -1, '', 'Connection lost'))
    await expect(a.upsertChat({ id: 'c', kind: 'group' })).rejects.toThrow(/Connection lost/)
    expect(fake.connections.at(-1)?.destroyed).toBe(true)
    expect(fake.checkedOut).toBe(0)
    expect(await a.getChat('c')).toEqual({ id: 'c', name: 'one' })
  })

  it('an upsert racing deleteChat ends with either no record or a fully merged one', async () => {
    for (let round = 0; round < 10; round++) {
      await a.upsertChat({ id: 'c', name: 'base', kind: 'group' })
      await Promise.all([a.deleteChat('c'), b.upsertChat({ id: 'c', name: `r${round}` })])
      const got = await a.getChat('c')
      if (got !== undefined) expect([{ id: 'c', name: `r${round}`, kind: 'group' }, { id: 'c', name: `r${round}` }]).toContainEqual(got)
    }
    expect(fake.checkedOut).toBe(0)
  })

  it('fails fast with a clear error when used before start()', async () => {
    const store = new MysqlStore()
    await expect(store.upsertChat({ id: 'c' })).rejects.toThrow(/start\(\)/)
    await expect(store.upsertContact({ id: 'u' })).rejects.toThrow(/start\(\)/)
  })
})
