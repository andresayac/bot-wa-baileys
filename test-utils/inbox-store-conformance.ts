/**
 * Shared conformance suite for `@bot-wa/inbox`'s `InboxStore`: tenant isolation,
 * compare-and-set upserts and updates (never a silent overwrite), bounded listings with
 * the active index, atomic message projection, notes and concurrency.
 * `MemoryInboxStore` is the reference; `KvInboxStore` must behave identically on every backend.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the runner).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredMessage } from '@bot-wa/core'
import type { InboxStore } from '../packages/inbox/src/store.js'

export interface InboxStoreHarness {
  /** A fresh store using `clock` as its time source, and its teardown. */
  make(options: { clock: () => number }): Promise<{ store: InboxStore; teardown: () => Promise<void> }>
}

const T0 = 1_700_000_000_000

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return { ref: { id: 'm1', chatId: 'chat-1' }, chatId: 'chat-1', timestamp: 1, type: 'text', body: 'hola', ...overrides }
}

export function runInboxStoreConformance(name: string, harness: InboxStoreHarness): void {
  describe(`${name} — InboxStore conformance`, () => {
    let store: InboxStore
    let teardown: () => Promise<void>
    let now = T0
    beforeEach(async () => {
      now = T0
      ;({ store, teardown } = await harness.make({ clock: () => now }))
    })
    afterEach(async () => { await teardown() })

    const open = (tenantId: string, id: string, extra: Record<string, unknown> = {}) => ({ tenantId, id, status: 'open' as const, handoff: false, ...extra })

    it('isolates tenants: the same conversation id in two tenants are two conversations', async () => {
      const a = await store.upsert(open('a', 'c'))
      await store.upsert(open('b', 'c', { assigneeId: 'other' }))
      expect(a).toEqual({ tenantId: 'a', id: 'c', status: 'open', handoff: false, unread: 0, version: 1, updatedAt: T0 })
      expect(await store.get('b', 'c')).toMatchObject({ assigneeId: 'other', version: 1 })
      expect(await store.get('c', 'c')).toBeUndefined()
      expect((await store.list('a')).map((c) => c.tenantId)).toEqual(['a'])
      await store.update('a', 'c', 1, { handoff: true })
      expect((await store.get('b', 'c'))?.handoff).toBe(false)
      await expect(store.update('c', 'c', 1, { handoff: true })).rejects.toMatchObject({ name: 'InboxNotFoundError' })
    })

    it('upsert is a compare-and-set: create with 0/omitted, merge with the current version', async () => {
      await expect(store.upsert(open('a', 'c'), 3)).rejects.toMatchObject({ name: 'InboxConflictError' })
      expect(await store.get('a', 'c')).toBeUndefined()
      const first = await store.upsert(open('a', 'c', { unread: 3 }), 0)
      expect(first).toMatchObject({ version: 1, unread: 3 })
      await expect(store.upsert(open('a', 'c'), 0)).rejects.toMatchObject({ name: 'InboxConflictError' })
      await expect(store.upsert(open('a', 'c'))).rejects.toMatchObject({ name: 'InboxConflictError' })
      now += 5
      const second = await store.upsert({ ...open('a', 'c', { status: 'pending', assigneeId: 'x', slaDueAt: 99 }) }, first.version)
      expect(second).toEqual({ tenantId: 'a', id: 'c', status: 'pending', handoff: false, assigneeId: 'x', slaDueAt: 99, unread: 3, version: 2, updatedAt: T0 + 5 })
      await expect(store.upsert(open('a', 'c'), first.version)).rejects.toMatchObject({ name: 'InboxConflictError' })
      expect(await store.get('a', 'c')).toEqual(second)
      await expect(store.upsert({ ...open('a', 'c'), unread: -1 }, second.version)).rejects.toThrow(RangeError)
    })

    it('update applies patches under the current version and clears optional fields with null', async () => {
      const created = await store.upsert(open('a', 'c', { assigneeId: 'x', slaDueAt: 10 }))
      await expect(store.update('a', 'missing', 1, { handoff: true })).rejects.toMatchObject({ name: 'InboxNotFoundError' })
      await expect(store.update('a', 'c', created.version + 1, { handoff: true })).rejects.toMatchObject({ name: 'InboxConflictError' })
      now += 1
      const patched = await store.update('a', 'c', created.version, { handoff: true, status: 'pending', unread: 7 })
      expect(patched).toEqual({ tenantId: 'a', id: 'c', status: 'pending', handoff: true, assigneeId: 'x', slaDueAt: 10, unread: 7, version: 2, updatedAt: T0 + 1 })
      const cleared = await store.update('a', 'c', patched.version, { assigneeId: null, slaDueAt: null })
      expect(cleared).toEqual({ tenantId: 'a', id: 'c', status: 'pending', handoff: true, unread: 7, version: 3, updatedAt: T0 + 1 })
      expect(cleared).not.toHaveProperty('assigneeId')
      await expect(store.update('a', 'c', cleared.version, { unread: 1.5 })).rejects.toThrow(RangeError)
      // A stale writer never overwrites: the handoff survives.
      await expect(store.update('a', 'c', created.version, { handoff: false })).rejects.toMatchObject({ name: 'InboxConflictError' })
      expect((await store.get('a', 'c'))?.handoff).toBe(true)
    })

    it('concurrent updates with the same expected version: exactly one succeeds', async () => {
      const created = await store.upsert(open('a', 'c'))
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.update('a', 'c', created.version, { assigneeId: `agent-${i}` }).then(() => true, () => false)))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect((await store.get('a', 'c'))?.version).toBe(2)
    })

    it('lists most recently updated first, filtered by status/assignee within the scan window', async () => {
      await store.upsert(open('a', 'c1', { assigneeId: 'x' }))
      now += 1
      await store.upsert(open('a', 'c2', { status: 'resolved', assigneeId: 'x' }))
      now += 1
      await store.upsert(open('a', 'c3', { status: 'pending' }))
      await store.upsert(open('b', 'c4', { assigneeId: 'x' }))
      expect((await store.list('a')).map((c) => c.id)).toEqual(['c3', 'c2', 'c1'])
      expect((await store.list('a', { status: 'open' })).map((c) => c.id)).toEqual(['c1'])
      expect((await store.list('a', { assigneeId: 'x' })).map((c) => c.id)).toEqual(['c2', 'c1'])
      expect((await store.list('a', { status: 'resolved', assigneeId: 'x' })).map((c) => c.id)).toEqual(['c2'])
      expect((await store.list('a', { limit: 2 })).map((c) => c.id)).toEqual(['c3', 'c2'])
      expect((await store.list('a', { limit: 0 }))).toEqual([])
      // scan bounds the candidates before filtering: only the 2 most recent are considered.
      expect((await store.list('a', { assigneeId: 'x', scan: 2 })).map((c) => c.id)).toEqual(['c2'])
      // ...but unresolved conversations are scanned on their own index, so resolved history never hides them.
      now += 1
      for (let i = 0; i < 5; i++) await store.upsert(open('a', `r${i}`, { status: 'resolved' }))
      expect((await store.list('a', { status: 'open', scan: 2 })).map((c) => c.id)).toEqual(['c1'])
      expect((await store.list('a', { status: 'pending', scan: 2 })).map((c) => c.id)).toEqual(['c3'])
      await expect(store.list('a', { limit: -1 })).rejects.toThrow(RangeError)
    })

    it('applyMessage creates or bumps the conversation atomically, never reverting agent fields', async () => {
      const created = await store.applyMessage(message({ direction: 'inbound' }))
      expect(created).toEqual({ tenantId: 'local', id: 'chat-1', status: 'open', handoff: false, unread: 1, version: 1, updatedAt: T0 })
      const handed = await store.update('local', 'chat-1', created.version, { handoff: true, assigneeId: 'agent', slaDueAt: 99, status: 'resolved' })
      now += 2
      expect(await store.applyMessage(message({ direction: 'outbound' }))).toEqual({ ...handed, version: handed.version + 1, updatedAt: T0 + 2 })
      expect(await store.applyMessage(message({ fromMe: false }))).toMatchObject({ unread: 2, handoff: true, assigneeId: 'agent', slaDueAt: 99, status: 'resolved', version: handed.version + 2 })
      expect(await store.applyMessage(message({ fromMe: true }))).toMatchObject({ unread: 2 })
      expect(await store.applyMessage(message({ fromMe: true, direction: 'inbound' }))).toMatchObject({ unread: 3 })
      expect(await store.applyMessage(message({ tenantId: 'acme', direction: 'inbound' }))).toMatchObject({ tenantId: 'acme', unread: 1, version: 1 })
      const before = await store.get('local', 'chat-1')
      await expect(store.applyMessage(message())).rejects.toThrow(/direction/)
      await expect(store.applyMessage(message({ chatId: 'chat-2' }))).rejects.toThrow(/direction/)
      expect(await store.get('local', 'chat-1')).toEqual(before)
      expect(await store.get('local', 'chat-2')).toBeUndefined()
      // 30 parallel inbound messages: every increment lands.
      await Promise.all(Array.from({ length: 30 }, () => store.applyMessage(message({ chatId: 'busy', direction: 'inbound' }))))
      expect(await store.get('local', 'busy')).toMatchObject({ unread: 30, version: 30 })
    })

    it('stores tenant-scoped notes in creation order and validates them', async () => {
      await store.upsert(open('a', 'c'))
      await expect(store.addNote('b', 'c', 'agent', 'hi')).rejects.toMatchObject({ name: 'InboxNotFoundError' })
      await expect(store.addNote('a', 'c', 'agent', '   ')).rejects.toThrow('note body is required')
      const first = await store.addNote('a', 'c', 'agent', 'needs review')
      expect(first).toEqual({ id: expect.any(String), tenantId: 'a', conversationId: 'c', authorId: 'agent', body: 'needs review', createdAt: T0 })
      now += 1
      const second = await store.addNote('a', 'c', 'agent', 'done')
      expect(await store.listNotes('a', 'c')).toEqual([first, second])
      expect(await store.listNotes('a', 'c', { limit: 1 })).toEqual([first])
      expect(await store.listNotes('b', 'c')).toEqual([])
      expect(await store.listNotes('a', 'other')).toEqual([])
    })

    it('returns copies that cannot mutate stored state', async () => {
      const created = await store.upsert(open('a', 'c'))
      created.status = 'resolved'
      ;(await store.get('a', 'c'))!.handoff = true
      ;(await store.list('a'))[0]!.unread = 99
      expect(await store.get('a', 'c')).toMatchObject({ status: 'open', handoff: false, unread: 0 })
      const note = await store.addNote('a', 'c', 'agent', 'x')
      note.body = 'tampered'
      expect((await store.listNotes('a', 'c'))[0]?.body).toBe('x')
    })

    it('rejects empty tenant and conversation ids', async () => {
      await expect(store.upsert(open('', 'c'))).rejects.toThrow(TypeError)
      await expect(store.upsert(open('a', ''))).rejects.toThrow(TypeError)
      await expect(store.list('')).rejects.toThrow(TypeError)
    })
  })
}
