/**
 * KvInboxStore — {@link InboxStore} persisted through any `DurableKv` of `@botmesh/core`
 * (SQLite, PostgreSQL, Redis, file or memory) via `@botmesh/tenant-kv`.
 *
 * Tables (one per tenant):
 *  - `product/inbox/conv/<tenant>`           id = conversation id; `all` index = most recently
 *    updated first, `active` index = the same for unresolved conversations only.
 *  - `product/inbox/note/<tenant>/<conv>`    id = `<createdAt>-<seq>-<random>`, creation order.
 *
 * The product-visible `version` lives inside the document; the backend's opaque version
 * is what the compare-and-set uses, so a stale agent write is refused by the backend
 * itself and surfaces as `InboxConflictError`.
 */

import type { DurableKv, StoredMessage } from '@botmesh/core'
import { TenantDocs, assertTenantId } from '@botmesh/tenant-kv'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_NOTES_LIMIT,
  DEFAULT_SCAN,
  applyPatch,
  assertLimit,
  assertNoteBody,
  matchesFilter,
  mergeUpsert,
  messageDirection,
  noteId,
  upsertAllowed,
} from './memory.js'
import type { InboxStore } from './store.js'
import {
  InboxConflictError,
  InboxNotFoundError,
  type ConversationStatus,
  type InboxConversation,
  type InboxListOptions,
  type InboxNote,
  type InboxPatch,
  type InboxUpsert,
} from './types.js'

export interface KvInboxStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
  /** Compare-and-set retries of `applyMessage` (see `@botmesh/tenant-kv`). */
  attempts?: number
}

const STATUSES: ReadonlySet<string> = new Set<ConversationStatus>(['open', 'pending', 'resolved'])
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseConversation(value: unknown): InboxConversation {
  if (!isRecord(value)) throw new TypeError('conversation is not an object')
  const { tenantId, id, status, handoff, unread, version, updatedAt } = value
  if (!isString(tenantId) || !isString(id) || !isString(status) || !STATUSES.has(status) || typeof handoff !== 'boolean') throw new TypeError('bad conversation')
  if (!isNumber(unread) || !isNumber(version) || !isNumber(updatedAt)) throw new TypeError('bad conversation counters')
  const doc: InboxConversation = { tenantId, id, status: status as ConversationStatus, handoff, unread, version, updatedAt }
  if (isString(value.assigneeId)) doc.assigneeId = value.assigneeId
  if (isNumber(value.slaDueAt)) doc.slaDueAt = value.slaDueAt
  return doc
}

function parseNote(value: unknown): InboxNote {
  if (!isRecord(value)) throw new TypeError('note is not an object')
  const { id, tenantId, conversationId, authorId, body, createdAt } = value
  if (![id, tenantId, conversationId, authorId, body].every(isString) || !isNumber(createdAt)) throw new TypeError('bad note')
  return { id: id as string, tenantId: tenantId as string, conversationId: conversationId as string, authorId: authorId as string, body: body as string, createdAt }
}

export class KvInboxStore implements InboxStore {
  private readonly conversations: TenantDocs<InboxConversation>
  private readonly notes: TenantDocs<InboxNote>
  private readonly clock: () => number

  constructor(kv: DurableKv, options: KvInboxStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
    const attempts = options.attempts !== undefined ? { attempts: options.attempts } : {}
    this.conversations = new TenantDocs<InboxConversation>(kv, {
      family: ['inbox', 'conv'],
      parse: parseConversation,
      order: (c) => -c.updatedAt,
      active: (c) => (c.status === 'resolved' ? null : -c.updatedAt),
      ...attempts,
    })
    this.notes = new TenantDocs<InboxNote>(kv, { family: ['inbox', 'note'], parse: parseNote, order: (n) => n.createdAt, ...attempts })
  }

  async upsert(input: InboxUpsert, expectedVersion?: number): Promise<InboxConversation> {
    assertTenantId(input.tenantId)
    assertTenantId(input.id, 'id')
    const table = this.conversations.in(input.tenantId)
    const current = await table.get(input.id)
    if (!upsertAllowed(current?.doc, expectedVersion)) throw new InboxConflictError()
    const next = mergeUpsert(current?.doc, input, this.clock())
    const written = current ? await table.replace(input.id, current.version, next) : await table.insert(input.id, next)
    if (!written) throw new InboxConflictError()
    return { ...written.doc }
  }

  async get(tenantId: string, id: string): Promise<InboxConversation | undefined> {
    assertTenantId(tenantId)
    return (await this.conversations.in(tenantId).get(id))?.doc
  }

  async list(tenantId: string, options: InboxListOptions = {}): Promise<InboxConversation[]> {
    assertTenantId(tenantId)
    const limit = assertLimit(options.limit, DEFAULT_LIST_LIMIT, 'limit')
    const scan = assertLimit(options.scan, DEFAULT_SCAN, 'scan')
    const activeOnly = options.status === 'open' || options.status === 'pending'
    const candidates = await this.conversations.in(tenantId).list({ index: activeOnly ? 'active' : 'all', limit: scan })
    return candidates.filter((c) => matchesFilter(c, options)).slice(0, limit)
  }

  async update(tenantId: string, id: string, expectedVersion: number, patch: InboxPatch): Promise<InboxConversation> {
    assertTenantId(tenantId)
    const table = this.conversations.in(tenantId)
    const current = await table.get(id)
    if (!current) throw new InboxNotFoundError()
    if (current.doc.version !== expectedVersion) throw new InboxConflictError()
    const next = { ...applyPatch(current.doc, patch), version: current.doc.version + 1, updatedAt: this.clock() }
    const written = await table.replace(id, current.version, next)
    if (!written) throw new InboxConflictError()
    return { ...written.doc }
  }

  async applyMessage(message: StoredMessage): Promise<InboxConversation> {
    const direction = messageDirection(message)
    const tenantId = message.tenantId ?? 'local'
    const delta = direction === 'inbound' ? 1 : 0
    const written = await this.conversations.in(tenantId).update(message.chatId, (cur) =>
      cur
        ? { ...cur, unread: cur.unread + delta, version: cur.version + 1, updatedAt: this.clock() }
        : { tenantId, id: message.chatId, status: 'open', handoff: false, unread: delta, version: 1, updatedAt: this.clock() },
    )
    return { ...written!.doc }
  }

  async addNote(tenantId: string, conversationId: string, authorId: string, body: string): Promise<InboxNote> {
    assertTenantId(tenantId)
    if (!(await this.conversations.in(tenantId).get(conversationId))) throw new InboxNotFoundError()
    assertNoteBody(body)
    const createdAt = this.clock()
    const note: InboxNote = { id: noteId(createdAt), tenantId, conversationId, authorId, body, createdAt }
    if (!(await this.notes.in(tenantId, conversationId).insert(note.id, note))) throw new Error('note id collision')
    return { ...note }
  }

  async listNotes(tenantId: string, conversationId: string, options: { limit?: number } = {}): Promise<InboxNote[]> {
    assertTenantId(tenantId)
    const limit = assertLimit(options.limit, DEFAULT_NOTES_LIMIT, 'limit')
    return this.notes.in(tenantId, conversationId).list({ limit })
  }
}
