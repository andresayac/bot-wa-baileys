/**
 * SQLiteStore — unit tests (v2 IStore).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { tmpdir } from 'os'
import { join } from 'path'
import { SQLiteStore } from '../src/SQLiteStore.js'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'

// Each test gets its own temp directory: on Windows a just-closed SQLite file can stay
// locked for a moment (EBUSY), so reusing one fixed path made the suite flaky.
let dir = ''
let TEST_DB = ''

function cleanup() {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

describe('SQLiteStore', () => {
  let store: SQLiteStore

  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'botwa-sqlite-')); TEST_DB = join(dir, 'test.db'); store = new SQLiteStore({ file: TEST_DB }); await store.start() })
  afterEach(async () => { await store.stop(); cleanup() })

  it('saves and retrieves a message', async () => {
    await store.saveMessage(msg('user@s.whatsapp.net', 'msg1', 'hello', 1))
    const got = await store.getMessage({ id: 'msg1', chatId: 'user@s.whatsapp.net' })
    expect(got?.body).toBe('hello')
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
  })

  it('upserts, lists and deletes chats', async () => {
    await store.upsertChat({ id: 'chat@g.us', name: 'Group', kind: 'group' })
    expect((await store.getChat('chat@g.us'))?.name).toBe('Group')
    await store.upsertChat({ id: 'chat@g.us', name: 'Renamed', kind: 'group' })
    expect((await store.getChat('chat@g.us'))?.name).toBe('Renamed')
    await store.upsertChat({ id: 'b@s.whatsapp.net' })
    expect(await store.listChats()).toHaveLength(2)
    await store.deleteChat('chat@g.us')
    expect(await store.listChats()).toHaveLength(1)
  })

  it('maxMessagesPerChat prunes the oldest messages beyond the cap', async () => {
    const CAP_DB = join(dir, 'cap.db')
    const capped = new SQLiteStore({ file: CAP_DB, maxMessagesPerChat: 3 })
    await capped.start()
    for (let i = 0; i < 6; i++) await capped.saveMessage(msg('c@s.whatsapp.net', `m${i}`, `msg ${i}`, 1000 + i))
    const kept = await capped.getMessagesByChat('c@s.whatsapp.net')
    expect(kept.map((m) => m.body)).toEqual(['msg 3', 'msg 4', 'msg 5']) // newest 3, oldest dropped
    // A different chat is unaffected.
    await capped.saveMessage(msg('other@s.whatsapp.net', 'o1', 'keep', 1))
    expect(await capped.getMessagesByChat('other@s.whatsapp.net')).toHaveLength(1)
    await capped.stop()
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
    expect(await store.listContacts()).toHaveLength(1)
  })

  it('manages checkpoints', async () => {
    const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana' }, updatedAt: 1 }
    await store.setCheckpoint('user@s.whatsapp.net', cp)
    const got = await store.getCheckpoint('user@s.whatsapp.net')
    expect(got?.flowId).toBe('register')
    expect(await store.listCheckpoints()).toHaveLength(1)
    await store.clearCheckpoint('user@s.whatsapp.net')
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toBeUndefined()
  })

  it('manages AI conversations', async () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello!' }]
    await store.setConversation('chat1', msgs)
    expect(await store.getConversation('chat1')).toEqual(msgs)
    await store.clearConversation('chat1')
    expect(await store.getConversation('chat1')).toBeUndefined()
  })

  it('persists a delivery cursor across instances', async () => {
    await store.setCursor('tg:updates', '4242')
    await store.stop()
    const store2 = new SQLiteStore({ file: TEST_DB })
    await store2.start()
    expect(await store2.getCursor('tg:updates')).toBe('4242')
    await store2.stop()
  })

  it('deletes a message', async () => {
    await store.saveMessage(msg('u@s.whatsapp.net', 'del1', 'bye', 1))
    await store.deleteMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })
    expect(await store.getMessage({ id: 'del1', chatId: 'u@s.whatsapp.net' })).toBeUndefined()
  })

  it('rejects an invalid maxMessagesPerChat up front', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SQLiteStore({ file: join(dir, 'bad.db'), maxMessagesPerChat: bad })).toThrow(RangeError)
    }
  })

  it('maxMessagesPerChat: 0 keeps no history at all', async () => {
    const none = new SQLiteStore({ file: join(dir, 'none.db'), maxMessagesPerChat: 0 })
    await none.start()
    await none.saveMessage(msg('c@x', 'm1', 'x', 1))
    expect(await none.getMessagesByChat('c@x')).toEqual([])
    await none.stop()
  })

  it('upgrades a database written by an older version (no user_data table) in place', async () => {
    const legacyFile = join(dir, 'legacy.db')
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
    const legacy = new Database(legacyFile)
    legacy.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT, timestamp INTEGER NOT NULL,
        type TEXT NOT NULL, body TEXT, from_me INTEGER, msg_json TEXT NOT NULL);
      CREATE TABLE chats (id TEXT PRIMARY KEY, chat_json TEXT NOT NULL);
      CREATE TABLE contacts (id TEXT PRIMARY KEY, contact_json TEXT NOT NULL);
      CREATE TABLE checkpoints (key TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL);
      CREATE TABLE conversations (key TEXT PRIMARY KEY, messages_json TEXT NOT NULL);
      CREATE TABLE cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const old = msg('c@x', 'm1', 'from v0', 1)
    legacy.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)').run('c@x:m1', 'c@x', 'c@x', 1, 'text', 'from v0', 0, JSON.stringify(old))
    legacy.prepare('INSERT INTO chats VALUES (?, ?)').run('c@x', JSON.stringify({ id: 'c@x', name: 'Old' }))
    legacy.close()

    const upgraded = new SQLiteStore({ file: legacyFile })
    await upgraded.start()
    expect(await upgraded.getMessagesByChat('c@x')).toEqual([old])
    await upgraded.upsertChat({ id: 'c@x', kind: 'group' })
    expect(await upgraded.getChat('c@x')).toEqual({ id: 'c@x', name: 'Old', kind: 'group' })
    await upgraded.setUserData({ userId: 'u', namespace: 'default', key: 'k', value: 1, updatedAt: 1 })
    expect((await upgraded.getUserData('u', 'default', 'k'))?.value).toBe(1)
    await upgraded.stop()
  })

  it('merges partial upserts made through two connections to the same file', async () => {
    const other = new SQLiteStore({ file: TEST_DB })
    await other.start()
    await Promise.all([
      store.upsertChat({ id: 'shared@x', name: 'Shared' }),
      other.upsertChat({ id: 'shared@x', kind: 'group' }),
      store.upsertContact({ id: 'u', name: 'Ana' }),
      other.upsertContact({ id: 'u', username: 'ana' }),
    ])
    expect(await store.getChat('shared@x')).toEqual({ id: 'shared@x', name: 'Shared', kind: 'group' })
    expect(await other.getContact('u')).toEqual({ id: 'u', name: 'Ana', username: 'ana' })
    await other.stop()
  })
})
