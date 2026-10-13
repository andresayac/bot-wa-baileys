/**
 * Shared IStore conformance suite.
 *
 * One set of assertions run against EVERY IStore implementation (MemoryStore +
 * the five persistent stores) so the contract stays uniform. Import it from a
 * store's test and pass a factory that yields a fresh, started store plus a
 * teardown. Type-only imports keep this file runtime-dependency-free (it only
 * needs `vitest`, which the runner injects).
 *
 * Ordering note: assertions use DISTINCT timestamps on purpose — tie-break
 * order for equal timestamps is intentionally NOT part of the contract and
 * varies by backend, so it isn't asserted here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { IStore, StoredMessage } from '@bot-wa/core'

/** An IStore whose optional delivery-cursor methods are known to be present. */
type CursorStore = IStore & Required<Pick<IStore, 'getCursor' | 'setCursor'>>

/**
 * The cursor methods are optional on `IStore`, but every store run through this
 * suite must implement them (the cursor test asserts it before narrowing).
 */
function hasCursor(store: IStore): store is CursorStore {
  return typeof store.getCursor === 'function' && typeof store.setCursor === 'function'
}

export interface ConformanceHarness {
  /** Build a fresh, started store and a teardown that releases it. */
  make(): Promise<{ store: IStore; teardown: () => Promise<void> }>
}

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

export function runStoreConformance(name: string, h: ConformanceHarness): void {
  describe(`IStore conformance: ${name}`, () => {
    let store: IStore
    let teardown: () => Promise<void>

    beforeEach(async () => {
      const made = await h.make()
      store = made.store
      teardown = made.teardown
    })
    afterEach(async () => { await teardown() })

    it('saves and reads back a message', async () => {
      await store.saveMessage(msg('c@x', 'm1', 'hello', 1))
      const got = await store.getMessage({ id: 'm1', chatId: 'c@x' })
      expect(got?.body).toBe('hello')
    })

    it('returns undefined for a missing message', async () => {
      expect(await store.getMessage({ id: 'nope', chatId: 'c@x' })).toBeUndefined()
    })

    it('lists a chat window oldest→newest, capped to the limit', async () => {
      for (let i = 0; i < 5; i++) await store.saveMessage(msg('c@x', `m${i}`, `msg ${i}`, 1000 + i))
      const win = await store.getMessagesByChat('c@x', 3)
      expect(win.map((m) => m.body)).toEqual(['msg 2', 'msg 3', 'msg 4'])
      const all = await store.getMessagesByChat('c@x')
      expect(all.map((m) => m.body)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
    })

    it('isolates message logs per chat', async () => {
      await store.saveMessage(msg('a@x', 'a1', 'in a', 1))
      await store.saveMessage(msg('b@x', 'b1', 'in b', 2))
      expect(await store.getMessagesByChat('a@x')).toHaveLength(1)
      expect(await store.getMessagesByChat('b@x')).toHaveLength(1)
    })

    it('deletes a single message', async () => {
      await store.saveMessage(msg('c@x', 'del', 'bye', 1))
      await store.saveMessage(msg('c@x', 'keep', 'stay', 2))
      await store.deleteMessage({ id: 'del', chatId: 'c@x' })
      expect((await store.getMessagesByChat('c@x')).map((m) => m.ref.id)).toEqual(['keep'])
    })

    it('deleteChat removes the record AND purges the chat message log', async () => {
      await store.saveMessage(msg('gone@x', 'g1', 'x', 1))
      await store.saveMessage(msg('stays@x', 's1', 'y', 2))
      await store.upsertChat({ id: 'gone@x', name: 'Gone' })
      await store.deleteChat('gone@x')
      expect(await store.getChat('gone@x')).toBeUndefined()
      expect(await store.getMessagesByChat('gone@x')).toHaveLength(0)
      expect(await store.getMessagesByChat('stays@x')).toHaveLength(1)
    })

    it('upsertChat shallow-merges over the existing record (partial keeps prior fields)', async () => {
      await store.upsertChat({ id: 'c@x', name: 'Group', kind: 'group' })
      await store.upsertChat({ id: 'c@x', name: 'Renamed' }) // omits `kind`
      const chat = await store.getChat('c@x')
      expect(chat?.name).toBe('Renamed')
      expect(chat?.kind).toBe('group') // preserved
    })

    it('upsertContact shallow-merges over the existing record', async () => {
      await store.upsertContact({ id: 'u@x', name: 'Alice', username: 'alice' })
      await store.upsertContact({ id: 'u@x', name: 'Alice B.' }) // omits username
      const c = await store.getContact('u@x')
      expect(c?.name).toBe('Alice B.')
      expect(c?.username).toBe('alice') // preserved
    })

    it('lists chats and contacts', async () => {
      await store.upsertChat({ id: 'c1' })
      await store.upsertChat({ id: 'c2' })
      await store.upsertContact({ id: 'u1' })
      expect((await store.listChats()).map((c) => c.id).sort()).toEqual(['c1', 'c2'])
      expect((await store.listContacts()).map((c) => c.id)).toEqual(['u1'])
    })

    it('deletes a contact without affecting others', async () => {
      await store.upsertContact({ id: 'delete-me' })
      await store.upsertContact({ id: 'keep-me' })
      await store.deleteContact('delete-me')
      expect(await store.getContact('delete-me')).toBeUndefined()
      expect((await store.listContacts()).map((contact) => contact.id)).toEqual(['keep-me'])
    })

    it('stores and reads a delivery cursor', async () => {
      const s = store
      expect(hasCursor(s), 'store must implement getCursor/setCursor').toBe(true)
      if (!hasCursor(s)) return // unreachable: the assertion above already failed
      expect(await s.getCursor('k')).toBeUndefined()
      await s.setCursor('k', '42')
      expect(await s.getCursor('k')).toBe('42')
    })

    it('manages flow checkpoints (set/get/list/clear)', async () => {
      const cp = { flowId: 'reg', step: 2, state: { name: 'Ana' }, updatedAt: 1 }
      await store.setCheckpoint('u@x', cp)
      expect((await store.getCheckpoint('u@x'))?.flowId).toBe('reg')
      expect(await store.listCheckpoints()).toEqual([['u@x', cp]])
      await store.clearCheckpoint('u@x')
      expect(await store.getCheckpoint('u@x')).toBeUndefined()
      expect(await store.listCheckpoints()).toHaveLength(0)
    })

    it('manages AI conversation history (set/get/clear)', async () => {
      const msgs = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'yo' }]
      await store.setConversation('c@x', msgs)
      expect(await store.getConversation('c@x')).toEqual(msgs)
      await store.clearConversation('c@x')
      expect(await store.getConversation('c@x')).toBeUndefined()
    })
  })
}
