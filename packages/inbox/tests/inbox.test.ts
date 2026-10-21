import { describe, expect, it } from 'vitest'
import { MemoryKv, type StoredMessage } from '@bot-wa/core'

import { Inbox, InboxConflictError, InboxNotFoundError, KvInboxStore, MemoryInboxStore } from '../src/index.js'

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    ref: { id: 'm1', chatId: 'chat-1' },
    chatId: 'chat-1',
    timestamp: 1,
    type: 'text',
    body: 'hola',
    ...overrides,
  }
}

/** The same facade logic over the memory store and over a kv-backed store, with a fixed clock. */
const stores = [
  ['MemoryInboxStore', () => new Inbox(new MemoryInboxStore({ clock: () => 1_000 }))],
  ['KvInboxStore', () => new Inbox(new KvInboxStore(new MemoryKv(), { clock: () => 1_000 }))],
] as const

describe.each(stores)('Inbox over %s', (_name, make) => {
  it('isolates tenants and prevents concurrent handoff overwrites', async () => {
    const inbox = make()
    const a = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })
    await inbox.upsert({ tenantId: 'b', id: 'c', status: 'open', handoff: false })

    const assigned = await inbox.assign('a', 'c', 'agent', a.version)

    expect(await inbox.list('b')).toHaveLength(1)
    await expect(inbox.handoff('a', 'c', true, a.version)).rejects.toThrow(InboxConflictError)
    expect(await inbox.handoff('a', 'c', true, assigned.version)).toMatchObject({ assigneeId: 'agent', handoff: true })
  })

  it('stores tenant-scoped internal notes', async () => {
    const inbox = make()
    await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    await inbox.addNote('a', 'c', 'agent', 'needs review')

    expect(await inbox.listNotes('a', 'c')).toHaveLength(1)
    expect(await inbox.listNotes('b', 'c')).toEqual([])
  })

  it('rejects notes for unknown conversations and blank bodies', async () => {
    const inbox = make()
    await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    await expect(inbox.addNote('b', 'c', 'agent', 'hi')).rejects.toThrow('conversation not found')
    await expect(inbox.addNote('b', 'c', 'agent', 'hi')).rejects.toBeInstanceOf(InboxNotFoundError)
    await expect(inbox.addNote('a', 'c', 'agent', '   ')).rejects.toThrow('note body is required')
  })

  it('bumps the version on every write and keeps unread unless provided', async () => {
    const inbox = make()
    const first = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false, unread: 3 })
    const second = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'pending', handoff: false }, first.version)

    expect(first.version).toBe(1)
    expect(second).toMatchObject({ version: 2, unread: 3, status: 'pending' })
    expect(await inbox.markRead('a', 'c', second.version)).toMatchObject({ version: 3, unread: 0 })
  })

  it('fails mutations on unknown conversations and stale versions', async () => {
    const inbox = make()
    const created = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    await expect(inbox.markRead('a', 'missing', 1)).rejects.toThrow('conversation not found')
    await expect(inbox.markRead('a', 'c', created.version + 1)).rejects.toThrow(InboxConflictError)
  })

  it('filters by status and assignee within a tenant', async () => {
    const inbox = make()
    await inbox.upsert({ tenantId: 'a', id: 'c1', status: 'open', handoff: false, assigneeId: 'x' })
    await inbox.upsert({ tenantId: 'a', id: 'c2', status: 'resolved', handoff: false, assigneeId: 'x' })
    await inbox.upsert({ tenantId: 'b', id: 'c3', status: 'open', handoff: false, assigneeId: 'x' })

    expect((await inbox.list('a', { status: 'open' })).map((c) => c.id)).toEqual(['c1'])
    // Same updatedAt (fixed clock): ties list by id.
    expect((await inbox.list('a', { assigneeId: 'x' })).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('resolves, reopens and sets the SLA under the current version', async () => {
    const inbox = make()
    const created = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })
    const resolved = await inbox.resolve('a', 'c', created.version)
    expect(resolved).toMatchObject({ status: 'resolved', version: 2 })
    expect(await inbox.list('a', { status: 'open' })).toEqual([])
    const reopened = await inbox.reopen('a', 'c', resolved.version)
    expect(reopened).toMatchObject({ status: 'open', version: 3 })
    const withSla = await inbox.setSla('a', 'c', 5_000, reopened.version)
    expect(withSla).toMatchObject({ slaDueAt: 5_000, version: 4 })
    const cleared = await inbox.setSla('a', 'c', undefined, withSla.version)
    expect(cleared).not.toHaveProperty('slaDueAt')
    expect(await inbox.assign('a', 'c', undefined, cleared.version)).not.toHaveProperty('assigneeId')
  })

  it('returns copies that cannot mutate stored state', async () => {
    const inbox = make()
    const created = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    created.status = 'resolved'
    ;(await inbox.get('a', 'c'))!.handoff = true

    expect(await inbox.get('a', 'c')).toMatchObject({ status: 'open', handoff: false })
    expect(await inbox.get('b', 'c')).toBeUndefined()
  })

  it('projects ledger messages, counting only inbound ones as unread', async () => {
    const inbox = make()

    const created = await inbox.projectMessage(message({ direction: 'inbound' }))
    expect(created).toMatchObject({ tenantId: 'local', id: 'chat-1', status: 'open', handoff: false, unread: 1 })

    const handedOff = await inbox.handoff('local', 'chat-1', true, created.version)
    expect(await inbox.projectMessage(message({ direction: 'outbound' }))).toMatchObject({
      unread: 1,
      handoff: true,
      version: handedOff.version + 1,
    })
    expect(await inbox.projectMessage(message({ tenantId: 'acme', direction: 'inbound' }))).toMatchObject({
      tenantId: 'acme',
      unread: 1,
    })
  })

  it('requires the current version to upsert an existing conversation', async () => {
    const inbox = make()
    const created = await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })
    const handedOff = await inbox.handoff('a', 'c', true, created.version)

    // Without a version, or with a stale one, upsert must not clobber the handoff.
    await expect(inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })).rejects.toThrow(InboxConflictError)
    await expect(inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, created.version)).rejects.toThrow(
      InboxConflictError,
    )
    expect(await inbox.get('a', 'c')).toMatchObject({ handoff: true, version: handedOff.version })

    expect(
      await inbox.upsert({ tenantId: 'a', id: 'c', status: 'resolved', handoff: false }, handedOff.version),
    ).toMatchObject({ status: 'resolved', handoff: false, version: handedOff.version + 1 })
  })

  it('creates with no version or 0 and rejects a non-zero version for a missing conversation', async () => {
    const inbox = make()

    await expect(inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, 3)).rejects.toThrow(InboxConflictError)
    expect(await inbox.get('a', 'c')).toBeUndefined()
    expect(await inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, 0)).toMatchObject({ version: 1 })
    // 0 means "create only": a second create loses.
    await expect(inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, 0)).rejects.toThrow(InboxConflictError)
  })

  it('projects a message atomically on top of the latest state', async () => {
    const inbox = make()
    const created = await inbox.projectMessage(message({ direction: 'inbound' }))
    const assigned = await inbox.assign('local', 'chat-1', 'agent', created.version)
    const resolved = await inbox.upsert(
      { tenantId: 'local', id: 'chat-1', status: 'resolved', handoff: false, assigneeId: 'agent', slaDueAt: 99 },
      assigned.version,
    )

    expect(await inbox.projectMessage(message({ direction: 'inbound' }))).toMatchObject({
      status: 'resolved',
      assigneeId: 'agent',
      slaDueAt: 99,
      unread: 2,
      version: resolved.version + 1,
    })
  })

  it('derives a missing direction from fromMe and rejects messages with neither', async () => {
    const inbox = make()

    expect(await inbox.projectMessage(message({ fromMe: false }))).toMatchObject({ unread: 1 })
    expect(await inbox.projectMessage(message({ fromMe: true }))).toMatchObject({ unread: 1 })
    // An explicit direction wins over fromMe.
    expect(await inbox.projectMessage(message({ fromMe: true, direction: 'inbound' }))).toMatchObject({ unread: 2 })

    const before = await inbox.get('local', 'chat-1')
    await expect(inbox.projectMessage(message())).rejects.toThrow(/direction/)
    await expect(inbox.projectMessage(message({ chatId: 'chat-2' }))).rejects.toThrow(/direction/)
    expect(await inbox.get('local', 'chat-1')).toEqual(before)
    expect(await inbox.get('local', 'chat-2')).toBeUndefined()
  })
})

describe('Inbox', () => {
  it('defaults to an in-memory store and persists across instances sharing one kv', async () => {
    expect(new Inbox().store).toBeInstanceOf(MemoryInboxStore)
    const kv = new MemoryKv()
    const first = new Inbox(new KvInboxStore(kv))
    const created = await first.projectMessage(message({ tenantId: 'acme', direction: 'inbound' }))
    await first.assign('acme', 'chat-1', 'agent-7', created.version)
    const second = new Inbox(new KvInboxStore(kv))
    expect(await second.get('acme', 'chat-1')).toMatchObject({ assigneeId: 'agent-7', unread: 1, version: 2 })
  })
})
