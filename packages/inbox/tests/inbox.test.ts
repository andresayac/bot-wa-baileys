import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@bot-wa/core'

import { InboxConflictError, MemoryInbox } from '../src/index.js'

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

describe('MemoryInbox', () => {
  it('isolates tenants and prevents concurrent handoff overwrites', () => {
    const inbox = new MemoryInbox()
    const a = inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })
    inbox.upsert({ tenantId: 'b', id: 'c', status: 'open', handoff: false })

    const assigned = inbox.assign('a', 'c', 'agent', a.version)

    expect(inbox.list('b')).toHaveLength(1)
    expect(() => inbox.handoff('a', 'c', true, a.version)).toThrow(InboxConflictError)
    expect(inbox.handoff('a', 'c', true, assigned.version)).toMatchObject({ assigneeId: 'agent', handoff: true })
  })

  it('stores tenant-scoped internal notes', () => {
    const inbox = new MemoryInbox()
    inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    inbox.addNote('a', 'c', 'agent', 'needs review')

    expect(inbox.listNotes('a', 'c')).toHaveLength(1)
    expect(inbox.listNotes('b', 'c')).toEqual([])
  })

  it('rejects notes for unknown conversations and blank bodies', () => {
    const inbox = new MemoryInbox()
    inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    expect(() => inbox.addNote('b', 'c', 'agent', 'hi')).toThrow('conversation not found')
    expect(() => inbox.addNote('a', 'c', 'agent', '   ')).toThrow('note body is required')
  })

  it('bumps the version on every write and keeps unread unless provided', () => {
    const inbox = new MemoryInbox()
    const first = inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false, unread: 3 })
    const second = inbox.upsert({ tenantId: 'a', id: 'c', status: 'pending', handoff: false }, first.version)

    expect(first.version).toBe(1)
    expect(second).toMatchObject({ version: 2, unread: 3, status: 'pending' })
    expect(inbox.markRead('a', 'c', second.version)).toMatchObject({ version: 3, unread: 0 })
  })

  it('fails mutations on unknown conversations and stale versions', () => {
    const inbox = new MemoryInbox()
    const created = inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    expect(() => inbox.markRead('a', 'missing', 1)).toThrow('conversation not found')
    expect(() => inbox.markRead('a', 'c', created.version + 1)).toThrow(InboxConflictError)
  })

  it('filters by status and assignee within a tenant', () => {
    const inbox = new MemoryInbox()
    inbox.upsert({ tenantId: 'a', id: 'c1', status: 'open', handoff: false, assigneeId: 'x' })
    inbox.upsert({ tenantId: 'a', id: 'c2', status: 'resolved', handoff: false, assigneeId: 'x' })
    inbox.upsert({ tenantId: 'b', id: 'c3', status: 'open', handoff: false, assigneeId: 'x' })

    expect(inbox.list('a', { status: 'open' }).map((c) => c.id)).toEqual(['c1'])
    expect(inbox.list('a', { assigneeId: 'x' }).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('returns copies that cannot mutate stored state', () => {
    const inbox = new MemoryInbox()
    const created = inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })

    created.status = 'resolved'
    inbox.get('a', 'c')!.handoff = true

    expect(inbox.get('a', 'c')).toMatchObject({ status: 'open', handoff: false })
    expect(inbox.get('b', 'c')).toBeUndefined()
  })

  it('projects ledger messages, counting only inbound ones as unread', () => {
    const inbox = new MemoryInbox()

    const created = inbox.projectMessage(message({ direction: 'inbound' }))
    expect(created).toMatchObject({ tenantId: 'local', id: 'chat-1', status: 'open', handoff: false, unread: 1 })

    const handedOff = inbox.handoff('local', 'chat-1', true, created.version)
    expect(inbox.projectMessage(message({ direction: 'outbound' }))).toMatchObject({
      unread: 1,
      handoff: true,
      version: handedOff.version + 1,
    })
    expect(inbox.projectMessage(message({ tenantId: 'acme', direction: 'inbound' }))).toMatchObject({
      tenantId: 'acme',
      unread: 1,
    })
  })

  it('requires the current version to upsert an existing conversation', () => {
    const inbox = new MemoryInbox()
    const created = inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })
    const handedOff = inbox.handoff('a', 'c', true, created.version)

    // Without a version, or with a stale one, upsert must not clobber the handoff.
    expect(() => inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false })).toThrow(InboxConflictError)
    expect(() => inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, created.version)).toThrow(
      InboxConflictError,
    )
    expect(inbox.get('a', 'c')).toMatchObject({ handoff: true, version: handedOff.version })

    expect(
      inbox.upsert({ tenantId: 'a', id: 'c', status: 'resolved', handoff: false }, handedOff.version),
    ).toMatchObject({ status: 'resolved', handoff: false, version: handedOff.version + 1 })
  })

  it('creates with no version or 0 and rejects a non-zero version for a missing conversation', () => {
    const inbox = new MemoryInbox()

    expect(() => inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, 3)).toThrow(InboxConflictError)
    expect(inbox.get('a', 'c')).toBeUndefined()
    expect(inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, 0)).toMatchObject({ version: 1 })
    // 0 means "create only": a second create loses.
    expect(() => inbox.upsert({ tenantId: 'a', id: 'c', status: 'open', handoff: false }, 0)).toThrow(InboxConflictError)
  })

  it('projects a message atomically on top of the latest state', () => {
    const inbox = new MemoryInbox()
    const created = inbox.projectMessage(message({ direction: 'inbound' }))
    const assigned = inbox.assign('local', 'chat-1', 'agent', created.version)
    const resolved = inbox.upsert(
      { tenantId: 'local', id: 'chat-1', status: 'resolved', handoff: false, assigneeId: 'agent', slaDueAt: 99 },
      assigned.version,
    )

    expect(inbox.projectMessage(message({ direction: 'inbound' }))).toMatchObject({
      status: 'resolved',
      assigneeId: 'agent',
      slaDueAt: 99,
      unread: 2,
      version: resolved.version + 1,
    })
  })

  it('derives a missing direction from fromMe and rejects messages with neither', () => {
    const inbox = new MemoryInbox()

    expect(inbox.projectMessage(message({ fromMe: false }))).toMatchObject({ unread: 1 })
    expect(inbox.projectMessage(message({ fromMe: true }))).toMatchObject({ unread: 1 })
    // An explicit direction wins over fromMe.
    expect(inbox.projectMessage(message({ fromMe: true, direction: 'inbound' }))).toMatchObject({ unread: 2 })

    const before = inbox.get('local', 'chat-1')
    expect(() => inbox.projectMessage(message())).toThrow(/direction/)
    expect(() => inbox.projectMessage(message({ chatId: 'chat-2' }))).toThrow(/direction/)
    expect(inbox.get('local', 'chat-1')).toEqual(before)
    expect(inbox.get('local', 'chat-2')).toBeUndefined()
  })
})
