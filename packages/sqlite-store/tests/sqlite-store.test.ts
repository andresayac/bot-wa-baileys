/**
 * SQLiteStore — unit tests (v2 IStore).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { SQLiteStore } from '../src/SQLiteStore.js'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'

const TEST_DB = './test-sqlite-store.db'

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix
    if (existsSync(f)) unlinkSync(f)
  }
}

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

describe('SQLiteStore', () => {
  let store: SQLiteStore

  beforeEach(async () => { cleanup(); store = new SQLiteStore({ file: TEST_DB }); await store.start() })
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
})
