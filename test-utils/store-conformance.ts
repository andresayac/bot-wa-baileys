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

    it('ignores a message without an id or a chat id (nothing stable to key it by)', async () => {
      // Providers emit `ref.id: ''` when they cannot guarantee a unique id (see the
      // inbound-id contract of IProvider). Keying those rows would make every such
      // message of a chat overwrite the previous one, and a later getMessage() of
      // another id-less ref would return an unrelated message.
      await store.saveMessage(msg('c@x', '', 'first', 1))
      await store.saveMessage(msg('c@x', '', 'second', 2))
      await store.saveMessage(msg('', 'm1', 'no chat', 3))
      expect(await store.getMessage({ id: '', chatId: 'c@x' })).toBeUndefined()
      expect(await store.getMessage({ id: 'm1', chatId: '' })).toBeUndefined()
      expect(await store.getMessagesByChat('c@x')).toEqual([])
      expect(await store.getMessagesByChat('')).toEqual([])
    })

    it('re-saving a message id replaces it instead of duplicating it', async () => {
      await store.saveMessage(msg('c@x', 'm1', 'draft', 1))
      await store.saveMessage({ ...msg('c@x', 'm1', 'edited', 1), status: 'read' })
      const window = await store.getMessagesByChat('c@x')
      expect(window).toHaveLength(1)
      expect(window[0]?.body).toBe('edited')
      expect((await store.getMessage({ id: 'm1', chatId: 'c@x' }))?.status).toBe('read')
    })

    it('round-trips every StoredMessage field', async () => {
      const full: StoredMessage = {
        ref: { id: 'full', chatId: 'c@x' },
        chatId: 'c@x',
        senderId: 'u@x',
        tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'conn',
        timestamp: 1_700_000_000_123,
        type: 'text',
        body: 'hola 🎲 "quoted" \\ back',
        fromMe: true,
        direction: 'outbound',
        status: 'failed',
        error: { code: 131047, message: 'outside window' },
        quoted: { id: 'q1', chatId: 'c@x' },
        raw: { nested: { list: [1, 'two', null, { deep: true }] }, empty: [], obj: {} },
      }
      await store.saveMessage(full)
      expect(await store.getMessage(full.ref)).toEqual(full)
      expect(await store.getMessagesByChat('c@x')).toEqual([full])
    })

    it('normalises the window limit like MemoryStore (0/negative → none, fraction rounds up, Infinity → all)', async () => {
      for (let i = 0; i < 5; i++) await store.saveMessage(msg('c@x', `m${i}`, `msg ${i}`, 1000 + i))
      expect(await store.getMessagesByChat('c@x', 0)).toEqual([])
      expect(await store.getMessagesByChat('c@x', -1)).toEqual([])
      expect((await store.getMessagesByChat('c@x', 2.5)).map((m) => m.body)).toEqual(['msg 2', 'msg 3', 'msg 4'])
      expect(await store.getMessagesByChat('c@x', Number.POSITIVE_INFINITY)).toHaveLength(5)
      expect(await store.getMessagesByChat('c@x', 1_000_000)).toHaveLength(5)
    })

    it('an own field set to undefined UNSETS it on upsert (chats and contacts)', async () => {
      await store.upsertChat({ id: 'c@x', name: 'Group', kind: 'group', lastMessageAt: 5 })
      await store.upsertChat({ id: 'c@x', name: undefined, lastMessageAt: 6 })
      expect(await store.getChat('c@x')).toEqual({ id: 'c@x', kind: 'group', lastMessageAt: 6 })

      await store.upsertContact({ id: 'u@x', name: 'Alice', username: 'alice' })
      await store.upsertContact({ id: 'u@x', username: undefined })
      expect(await store.getContact('u@x')).toEqual({ id: 'u@x', name: 'Alice' })
    })

    it('concurrent partial upserts of one record keep every field (no lost update)', async () => {
      await Promise.all([
        store.upsertChat({ id: 'race@x', name: 'Race' }),
        store.upsertChat({ id: 'race@x', kind: 'group' }),
        store.upsertChat({ id: 'race@x', lastMessageAt: 7 }),
        store.upsertContact({ id: 'race-u', name: 'Ana' }),
        store.upsertContact({ id: 'race-u', username: 'ana' }),
        store.upsertContact({ id: 'race-u', phoneNumber: '+57' }),
      ])
      expect(await store.getChat('race@x')).toEqual({ id: 'race@x', name: 'Race', kind: 'group', lastMessageAt: 7 })
      expect(await store.getContact('race-u')).toEqual({ id: 'race-u', name: 'Ana', username: 'ana', phoneNumber: '+57' })
    })

    it('overwrites cursors, checkpoints and conversations in place', async () => {
      const s = store
      if (!hasCursor(s)) throw new Error('store must implement getCursor/setCursor')
      await s.setCursor('k', '1')
      await s.setCursor('k', '2')
      expect(await s.getCursor('k')).toBe('2')

      const cp = (step: number) => ({ flowId: 'reg', step, state: { step }, updatedAt: step })
      await store.setCheckpoint('a', cp(1))
      await store.setCheckpoint('b', cp(1))
      await store.setCheckpoint('a', cp(2))
      const listed = (await store.listCheckpoints()).sort(([x], [y]) => x.localeCompare(y))
      expect(listed).toEqual([['a', cp(2)], ['b', cp(1)]])

      await store.setConversation('c@x', [{ role: 'user', content: 'one' }])
      await store.setConversation('c@x', [{ role: 'assistant', content: 'two' }])
      expect(await store.getConversation('c@x')).toEqual([{ role: 'assistant', content: 'two' }])
    })

    it('hands out conversation copies (mutating a result never changes the store)', async () => {
      await store.setConversation('c@x', [{ role: 'user', content: 'hi' }])
      const got = await store.getConversation('c@x')
      got?.push({ role: 'assistant', content: 'mutated' })
      expect(await store.getConversation('c@x')).toEqual([{ role: 'user', content: 'hi' }])
    })

    it('treats deleting or clearing missing data as a no-op', async () => {
      await store.deleteMessage({ id: 'ghost', chatId: 'ghost@x' })
      await store.deleteChat('ghost@x')
      await store.deleteContact('ghost')
      await store.clearCheckpoint('ghost')
      await store.clearConversation('ghost')
      expect(await store.listChats()).toEqual([])
      expect(await store.listContacts()).toEqual([])
      expect(await store.listCheckpoints()).toEqual([])
    })
  })
}
