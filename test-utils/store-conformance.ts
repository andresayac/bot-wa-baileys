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
import type { FlowCheckpoint, IStore, StoredMessage } from '@botmesh/core'

/** An IStore whose optional delivery-cursor methods are known to be present. */
type CursorStore = IStore & Required<Pick<IStore, 'getCursor' | 'setCursor'>>

/**
 * The cursor methods are optional on `IStore`, but every store run through this
 * suite must implement them (the cursor test asserts it before narrowing).
 */
function hasCursor(store: IStore): store is CursorStore {
  return typeof store.getCursor === 'function' && typeof store.setCursor === 'function'
}

/** An IStore whose optional checkpoint compare-and-set methods are known to be present. */
type CasStore = IStore & Required<Pick<IStore, 'setCheckpointIf' | 'clearCheckpointIf'>>

function hasCheckpointCas(store: IStore): store is CasStore {
  return typeof store.setCheckpointIf === 'function' && typeof store.clearCheckpointIf === 'function'
}

export interface ConformanceHarness {
  /**
   * `true` (the six built-in stores): the store MUST implement `setCheckpointIf` /
   * `clearCheckpointIf` and the compare-and-set block fails when it does not. Omitted: the
   * block runs when the store has them and is skipped otherwise (custom stores).
   */
  checkpointCas?: boolean
  /**
   * Build a fresh, started store and a teardown that releases it. Persistent
   * stores also return `seedLegacyMessage`, which writes a message row straight
   * into the backend under the PRE-ESCAPING key (`legacyMessageKey`, i.e.
   * `${chatId}:${id}`) exactly as older versions of the store did, so the
   * legacy-key migration tests can run.
   */
  make(): Promise<{
    store: IStore
    teardown: () => Promise<void>
    seedLegacyMessage?: (msg: StoredMessage) => Promise<void>
  }>
}

const msg = (chatId: string, id: string, body: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false,
})

export function runStoreConformance(name: string, h: ConformanceHarness): void {
  describe(`IStore conformance: ${name}`, () => {
    let store: IStore
    let teardown: () => Promise<void>
    let seedLegacy: ((msg: StoredMessage) => Promise<void>) | undefined

    beforeEach(async () => {
      const made = await h.make()
      store = made.store
      teardown = made.teardown
      seedLegacy = made.seedLegacyMessage
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

    it('round-trips the optional checkpoint fields opaquely (trace context included)', async () => {
      const cp = {
        flowId: 'reg', step: 1, state: {}, updatedAt: 2, parked: true,
        trace: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', tracestate: 'vendor=a' },
      }
      await store.setCheckpoint('t@x', cp)
      expect(await store.getCheckpoint('t@x')).toEqual(cp)
      await store.clearCheckpoint('t@x')
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

    it('normalises the window limit like MemoryStore (0/negative → none, fraction rounds up, huge or Infinity → all)', async () => {
      for (let i = 0; i < 5; i++) await store.saveMessage(msg('c@x', `m${i}`, `msg ${i}`, 1000 + i))
      expect(await store.getMessagesByChat('c@x', 0)).toEqual([])
      expect(await store.getMessagesByChat('c@x', -1)).toEqual([])
      expect((await store.getMessagesByChat('c@x', 2.5)).map((m) => m.body)).toEqual(['msg 2', 'msg 3', 'msg 4'])
      expect(await store.getMessagesByChat('c@x', Number.POSITIVE_INFINITY)).toHaveLength(5)
      expect(await store.getMessagesByChat('c@x', 1_000_000)).toHaveLength(5)
      expect(await store.getMessagesByChat('c@x', 1e20)).toHaveLength(5)
      expect(await store.getMessagesByChat('c@x', Number.MAX_VALUE)).toHaveLength(5)
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

    it('ids containing ":" or "%" never collide (Twilio-style "whatsapp:+1…" chat ids)', async () => {
      // The former `${chatId}:${id}` key mapped both of these to "a:b:c".
      await store.saveMessage(msg('a:b', 'c', 'chat a:b', 1))
      await store.saveMessage(msg('a', 'b:c', 'chat a', 2))
      // A literal "%3A" must not alias an escaped ':' either.
      await store.saveMessage(msg('a%3Ab', 'c', 'chat a%3Ab', 3))
      expect((await store.getMessage({ chatId: 'a:b', id: 'c' }))?.body).toBe('chat a:b')
      expect((await store.getMessage({ chatId: 'a', id: 'b:c' }))?.body).toBe('chat a')
      expect((await store.getMessage({ chatId: 'a%3Ab', id: 'c' }))?.body).toBe('chat a%3Ab')
      expect((await store.getMessagesByChat('a:b')).map((m) => m.body)).toEqual(['chat a:b'])
      expect((await store.getMessagesByChat('a')).map((m) => m.body)).toEqual(['chat a'])
      expect((await store.getMessagesByChat('a%3Ab')).map((m) => m.body)).toEqual(['chat a%3Ab'])

      await store.deleteMessage({ chatId: 'a:b', id: 'c' })
      expect(await store.getMessage({ chatId: 'a:b', id: 'c' })).toBeUndefined()
      expect((await store.getMessage({ chatId: 'a', id: 'b:c' }))?.body).toBe('chat a')
      expect((await store.getMessage({ chatId: 'a%3Ab', id: 'c' }))?.body).toBe('chat a%3Ab')

      await store.saveMessage(msg('a:b', 'c', 'again', 4))
      await store.deleteChat('a')
      expect(await store.getMessage({ chatId: 'a', id: 'b:c' })).toBeUndefined()
      expect((await store.getMessage({ chatId: 'a:b', id: 'c' }))?.body).toBe('again')
    })

    it("never mixes up same-chat ids whose legacy key is another message's key", async () => {
      // legacyMessageKey(('c', '%3A')) === 'c:%3A' === messageKey(('c', ':')).
      await store.saveMessage(msg('c', ':', 'colon', 1))
      expect(await store.getMessage({ chatId: 'c', id: '%3A' })).toBeUndefined()
      await store.deleteMessage({ chatId: 'c', id: '%3A' })
      expect((await store.getMessage({ chatId: 'c', id: ':' }))?.body).toBe('colon')
      await store.saveMessage(msg('c', '%3A', 'percent', 2))
      expect((await store.getMessage({ chatId: 'c', id: ':' }))?.body).toBe('colon')
      expect((await store.getMessage({ chatId: 'c', id: '%3A' }))?.body).toBe('percent')
      expect((await store.getMessagesByChat('c')).map((m) => m.body)).toEqual(['colon', 'percent'])
      await store.deleteMessage({ chatId: 'c', id: '%3A' })
      expect((await store.getMessagesByChat('c')).map((m) => m.body)).toEqual(['colon'])
    })

    describe('legacy `${chatId}:${id}` rows (written before keys were escaped)', () => {
      const legacyIt = (title: string, fn: (seed: (m: StoredMessage) => Promise<void>) => Promise<void>) =>
        it(title, async (ctx) => {
          if (!seedLegacy) return ctx.skip() // in-memory stores have no rows from older versions
          await fn(seedLegacy)
        })

      legacyIt('reads and lists a legacy row', async (seed) => {
        await seed(msg('whatsapp:+1555', 'SM1', 'old', 1))
        expect((await store.getMessage({ chatId: 'whatsapp:+1555', id: 'SM1' }))?.body).toBe('old')
        expect((await store.getMessagesByChat('whatsapp:+1555')).map((m) => m.body)).toEqual(['old'])
      })

      legacyIt('re-saving a legacy message replaces it (no duplicate in the window)', async (seed) => {
        await seed(msg('whatsapp:+1555', 'SM1', 'old', 1))
        await store.saveMessage({ ...msg('whatsapp:+1555', 'SM1', 'new', 1), status: 'read' })
        expect((await store.getMessagesByChat('whatsapp:+1555')).map((m) => m.body)).toEqual(['new'])
        expect((await store.getMessage({ chatId: 'whatsapp:+1555', id: 'SM1' }))?.status).toBe('read')
      })

      legacyIt('deletes a legacy row (deleteMessage and deleteChat)', async (seed) => {
        await seed(msg('whatsapp:+1555', 'SM1', 'one', 1))
        await seed(msg('whatsapp:+1555', 'SM2', 'two', 2))
        await store.deleteMessage({ chatId: 'whatsapp:+1555', id: 'SM1' })
        expect(await store.getMessage({ chatId: 'whatsapp:+1555', id: 'SM1' })).toBeUndefined()
        expect((await store.getMessagesByChat('whatsapp:+1555')).map((m) => m.body)).toEqual(['two'])
        await store.deleteChat('whatsapp:+1555')
        expect(await store.getMessage({ chatId: 'whatsapp:+1555', id: 'SM2' })).toBeUndefined()
        expect(await store.getMessagesByChat('whatsapp:+1555')).toEqual([])
      })

      legacyIt('never returns a legacy row that belongs to another message', async (seed) => {
        // Legacy key "a:b:c" belongs to ('a', 'b:c'), not to ('a:b', 'c').
        await seed(msg('a', 'b:c', 'owner a', 1))
        expect(await store.getMessage({ chatId: 'a:b', id: 'c' })).toBeUndefined()
        expect((await store.getMessage({ chatId: 'a', id: 'b:c' }))?.body).toBe('owner a')
        // Legacy key "x%3Ay:z" is also the NEW key of ('x:y', 'z').
        await seed(msg('x%3Ay', 'z', 'owner x%3Ay', 2))
        expect(await store.getMessage({ chatId: 'x:y', id: 'z' })).toBeUndefined()
        expect((await store.getMessage({ chatId: 'x%3Ay', id: 'z' }))?.body).toBe('owner x%3Ay')
        // Deleting the non-owner leaves the legacy rows alone.
        await store.deleteMessage({ chatId: 'a:b', id: 'c' })
        await store.deleteMessage({ chatId: 'x:y', id: 'z' })
        expect((await store.getMessage({ chatId: 'a', id: 'b:c' }))?.body).toBe('owner a')
        expect((await store.getMessage({ chatId: 'x%3Ay', id: 'z' }))?.body).toBe('owner x%3Ay')
      })
      legacyIt("never returns a legacy row stored under another message's escaped key", async (seed) => {
        // The legacy row of ('c', '%3A') sits under 'c:%3A', the NEW key of ('c', ':').
        await seed(msg('c', '%3A', 'old percent', 1))
        expect(await store.getMessage({ chatId: 'c', id: ':' })).toBeUndefined()
        await store.deleteMessage({ chatId: 'c', id: ':' })
        expect((await store.getMessage({ chatId: 'c', id: '%3A' }))?.body).toBe('old percent')
        await store.saveMessage(msg('c', '%3A', 'new percent', 1))
        expect((await store.getMessagesByChat('c')).map((m) => m.body)).toEqual(['new percent'])
      })
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

    describe('checkpoint compare-and-set (setCheckpointIf / clearCheckpointIf)', () => {
      const cp = (revision: number | undefined, step = 1): FlowCheckpoint => ({
        flowId: 'reg', step, state: { step }, updatedAt: step, ...(revision === undefined ? {} : { revision }),
      })
      /** The store under test, narrowed; skips the case for a custom store without the methods. */
      const casIt = (title: string, fn: (s: CasStore) => Promise<void>, timeout?: number) =>
        it(title, async (ctx) => {
          if (!hasCheckpointCas(store)) {
            if (h.checkpointCas) throw new Error('store must implement setCheckpointIf/clearCheckpointIf')
            return ctx.skip()
          }
          await fn(store)
        }, timeout)

      casIt('inserts when no row exists (expected 0) and refuses expected 0 once a revisioned row exists', async (s) => {
        expect(await s.setCheckpointIf('k', cp(1), 0)).toBe(true)
        expect(await s.getCheckpoint('k')).toEqual(cp(1))
        expect(await s.setCheckpointIf('k', cp(1, 9), 0)).toBe(false)
        expect(await s.getCheckpoint('k')).toEqual(cp(1)) // untouched
      })

      casIt('replaces with the right revision and refuses a stale one', async (s) => {
        expect(await s.setCheckpointIf('k', cp(1), 0)).toBe(true)
        expect(await s.setCheckpointIf('k', cp(2, 2), 1)).toBe(true)
        expect(await s.getCheckpoint('k')).toEqual(cp(2, 2))
        expect(await s.setCheckpointIf('k', cp(2, 3), 1)).toBe(false) // stale writer
        expect(await s.setCheckpointIf('k', cp(4, 4), 3)).toBe(false) // never that far
        expect(await s.getCheckpoint('k')).toEqual(cp(2, 2))
        expect(await s.setCheckpointIf('k', cp(3, 3), 2)).toBe(true)
        expect(await s.getCheckpoint('k')).toEqual(cp(3, 3))
      })

      casIt('upgrades a row written by setCheckpoint (no revision) as revision 0', async (s) => {
        await s.setCheckpoint('k', cp(undefined))
        expect(await s.setCheckpointIf('k', cp(1, 5), 1)).toBe(false)
        expect(await s.setCheckpointIf('k', cp(1, 5), 0)).toBe(true)
        expect(await s.getCheckpoint('k')).toEqual(cp(1, 5))
        expect(await s.setCheckpointIf('k', cp(2, 6), 0)).toBe(false)
      })

      casIt('clearCheckpointIf: absent is true, a matching revision deletes, a mismatch leaves the row', async (s) => {
        expect(await s.clearCheckpointIf('k', 0)).toBe(true)
        expect(await s.clearCheckpointIf('k', 3)).toBe(true)
        expect(await s.setCheckpointIf('k', cp(1), 0)).toBe(true)
        expect(await s.clearCheckpointIf('k', 0)).toBe(false)
        expect(await s.clearCheckpointIf('k', 2)).toBe(false)
        expect(await s.getCheckpoint('k')).toEqual(cp(1))
        expect(await s.clearCheckpointIf('k', 1)).toBe(true)
        expect(await s.getCheckpoint('k')).toBeUndefined()
        await s.setCheckpoint('legacy', cp(undefined))
        expect(await s.clearCheckpointIf('legacy', 1)).toBe(false)
        expect(await s.clearCheckpointIf('legacy', 0)).toBe(true)
        expect(await s.getCheckpoint('legacy')).toBeUndefined()
      })

      casIt('revision round-trips through get and list, with every other optional field', async (s) => {
        const full: FlowCheckpoint = {
          flowId: 'reg', step: 2, state: { name: 'Ana' }, updatedAt: 7, parked: true, revision: 1,
          inboundId: 'in-1', cause: { id: 'in-1', seq: 2 },
          handover: { kind: 'ephemeral', expiresAt: 99, shape: 'abc', name: 'reg' },
          trace: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
        }
        expect(await s.setCheckpointIf('k', full, 0)).toBe(true)
        expect(await s.getCheckpoint('k')).toEqual(full)
        expect(await s.listCheckpoints()).toEqual([['k', full]])
      })

      casIt('plain setCheckpoint still overwrites unconditionally (and resets the revision it writes)', async (s) => {
        expect(await s.setCheckpointIf('k', cp(3), 0)).toBe(true)
        await s.setCheckpoint('k', cp(undefined, 8))
        expect(await s.getCheckpoint('k')).toEqual(cp(undefined, 8))
        expect(await s.setCheckpointIf('k', cp(1, 9), 3)).toBe(false)
        expect(await s.setCheckpointIf('k', cp(1, 9), 0)).toBe(true)
      })

      casIt('keys are independent (a revision chain never leaks into another key)', async (s) => {
        expect(await s.setCheckpointIf('a', cp(1), 0)).toBe(true)
        expect(await s.setCheckpointIf('b', cp(1), 0)).toBe(true)
        expect(await s.setCheckpointIf('a', cp(2), 1)).toBe(true)
        expect(await s.setCheckpointIf('b', cp(2), 2)).toBe(false)
        expect(await s.clearCheckpointIf('a', 2)).toBe(true)
        expect(await s.getCheckpoint('b')).toEqual(cp(1))
      })

      casIt('rejects an expected revision that is not a non-negative integer', async (s) => {
        for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          await expect(s.setCheckpointIf('k', cp(1), bad)).rejects.toBeInstanceOf(RangeError)
          await expect(s.clearCheckpointIf('k', bad)).rejects.toBeInstanceOf(RangeError)
        }
        expect(await s.getCheckpoint('k')).toBeUndefined()
      })

      casIt('50 concurrent conditional writes with the same expectation: exactly one winner per revision', async (s) => {
        const first = await Promise.all(Array.from({ length: 50 }, (_, i) => s.setCheckpointIf('race', cp(1, i), 0)))
        expect(first.filter(Boolean)).toHaveLength(1)
        const winner = first.indexOf(true)
        expect(await s.getCheckpoint('race')).toEqual(cp(1, winner))
        const second = await Promise.all(Array.from({ length: 50 }, (_, i) => s.setCheckpointIf('race', cp(2, 100 + i), 1)))
        expect(second.filter(Boolean)).toHaveLength(1)
        expect((await s.getCheckpoint('race'))?.revision).toBe(2)
        const clears = await Promise.all(Array.from({ length: 10 }, () => s.clearCheckpointIf('race', 2)))
        // The first clear deletes the row; the later ones find it absent (true as well).
        expect(clears.every(Boolean)).toBe(true)
        expect(await s.getCheckpoint('race')).toBeUndefined()
      }, 20_000)
    })
  })
}
