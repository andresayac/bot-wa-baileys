/**
 * SQLiteStore — unit tests for the persistent SQLite-backed store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { SQLiteStore } from '../src/store/SQLiteStore.js'
import type { FlowCheckpoint } from '../src/store/IStore.js'

const TEST_DB = './test-sqlite-store.db'

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix
    if (existsSync(f)) unlinkSync(f)
  }
}

describe('SQLiteStore', () => {
  let store: SQLiteStore

  beforeEach(async () => {
    cleanup()
    store = new SQLiteStore({ file: TEST_DB })
    await store.start()
  })

  afterEach(async () => {
    await store.stop()
    cleanup()
  })

  it('saves and retrieves a message', async () => {
    const msg = {
      key: { remoteJid: 'user@s.whatsapp.net', id: 'msg1', fromMe: false },
      message: { conversation: 'hello' },
      messageTimestamp: Date.now(),
    }
    await store.saveMessage(msg as any)
    const retrieved = await store.getMessage(msg.key as any)
    expect(retrieved).toEqual({ conversation: 'hello' })
  })

  it('returns undefined for missing message', async () => {
    const result = await store.getMessage({ remoteJid: 'x@s.whatsapp.net', id: 'nope' } as any)
    expect(result).toBeUndefined()
  })

  it('lists messages by chat in order', async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveMessage({
        key: { remoteJid: 'chat@s.whatsapp.net', id: `m${i}`, fromMe: false },
        message: { conversation: `msg ${i}` },
        messageTimestamp: 1000 + i,
      } as any)
    }
    const msgs = await store.getMessagesByChat('chat@s.whatsapp.net', 3)
    expect(msgs).toHaveLength(3)
    // Should be the 3 most recent, in ascending order
    expect((msgs[0].message as any).conversation).toBe('msg 2')
    expect((msgs[2].message as any).conversation).toBe('msg 4')
  })

  it('upserts and retrieves chats', async () => {
    await store.upsertChat({ id: 'chat@g.us', name: 'Group' } as any)
    const chat = await store.getChat('chat@g.us')
    expect(chat?.name).toBe('Group')

    // Upsert overwrites
    await store.upsertChat({ id: 'chat@g.us', name: 'Renamed' } as any)
    const updated = await store.getChat('chat@g.us')
    expect(updated?.name).toBe('Renamed')
  })

  it('lists and deletes chats', async () => {
    await store.upsertChat({ id: 'a@s.whatsapp.net' } as any)
    await store.upsertChat({ id: 'b@s.whatsapp.net' } as any)
    expect(await store.listChats()).toHaveLength(2)

    await store.deleteChat('a@s.whatsapp.net')
    expect(await store.listChats()).toHaveLength(1)
  })

  it('upserts and retrieves contacts', async () => {
    await store.upsertContact({ id: 'user@s.whatsapp.net', name: 'Alice' } as any)
    const contact = await store.getContact('user@s.whatsapp.net')
    expect(contact?.name).toBe('Alice')
    expect(await store.listContacts()).toHaveLength(1)
  })

  it('manages flow state', async () => {
    await store.setFlowState('user1', { step: 3, name: 'Bob' })
    const state = await store.getFlowState('user1')
    expect(state).toEqual({ step: 3, name: 'Bob' })

    await store.clearFlowState('user1')
    expect(await store.getFlowState('user1')).toBeUndefined()
  })

  it('manages checkpoints', async () => {
    const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana' }, updatedAt: Date.now() }
    await store.setCheckpoint('user@s.whatsapp.net', cp)

    const retrieved = await store.getCheckpoint('user@s.whatsapp.net')
    expect(retrieved?.flowId).toBe('register')
    expect(retrieved?.state).toEqual({ name: 'Ana' })

    const list = await store.listCheckpoints()
    expect(list).toHaveLength(1)

    await store.clearCheckpoint('user@s.whatsapp.net')
    expect(await store.getCheckpoint('user@s.whatsapp.net')).toBeUndefined()
  })

  it('manages AI conversations', async () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello!' },
    ]
    await store.setConversation('chat1', msgs)
    const retrieved = await store.getConversation('chat1')
    expect(retrieved).toEqual(msgs)

    await store.clearConversation('chat1')
    expect(await store.getConversation('chat1')).toBeUndefined()
  })

  it('persists data across instances', async () => {
    await store.setFlowState('persist-test', { value: 42 })
    await store.stop()

    // Reopen
    const store2 = new SQLiteStore({ file: TEST_DB })
    await store2.start()
    const state = await store2.getFlowState('persist-test')
    expect(state).toEqual({ value: 42 })
    await store2.stop()
  })

  it('updates a message', async () => {
    await store.saveMessage({
      key: { remoteJid: 'u@s.whatsapp.net', id: 'upd1', fromMe: false },
      message: { conversation: 'original' },
      messageTimestamp: Date.now(),
    } as any)

    const updated = await store.updateMessage(
      { remoteJid: 'u@s.whatsapp.net', id: 'upd1' } as any,
      { message: { conversation: 'edited' } } as any,
    )
    expect((updated?.message as any).conversation).toBe('edited')
  })

  it('deletes a message', async () => {
    await store.saveMessage({
      key: { remoteJid: 'u@s.whatsapp.net', id: 'del1', fromMe: false },
      message: { conversation: 'bye' },
      messageTimestamp: Date.now(),
    } as any)

    await store.deleteMessage({ remoteJid: 'u@s.whatsapp.net', id: 'del1' } as any)
    expect(await store.getMessage({ remoteJid: 'u@s.whatsapp.net', id: 'del1' } as any)).toBeUndefined()
  })
})
