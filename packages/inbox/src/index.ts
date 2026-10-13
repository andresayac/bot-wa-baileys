/**
 * @bot-wa/inbox — in-memory prototype of a tenant-isolated omnichannel inbox.
 *
 * - {@link MemoryInbox} — conversations with optimistic concurrency (CAS on
 *   `version`), assignment, bot/human handoff, unread counters and internal notes.
 * - {@link MemoryInbox.projectMessage} — folds a core `StoredMessage` from the
 *   message ledger into its inbox conversation.
 *
 * Private prototype: state lives in RAM and is not published to npm.
 *
 * @example
 * ```ts
 * const inbox = new MemoryInbox()
 * const conversation = inbox.projectMessage(storedMessage)
 * const assigned = inbox.assign('acme', conversation.id, 'agent-7', conversation.version)
 * inbox.handoff('acme', assigned.id, true, assigned.version)
 * ```
 */

import type { StoredMessage } from '@bot-wa/core'

/** Lifecycle state of an inbox conversation. */
export type ConversationStatus = 'open' | 'pending' | 'resolved'

/** One conversation as seen by human agents, scoped to a tenant. */
export interface InboxConversation {
  tenantId: string
  /** Conversation id; {@link MemoryInbox.projectMessage} uses the message `chatId`. */
  id: string
  status: ConversationStatus
  /** Agent currently assigned, if any. */
  assigneeId?: string
  /** `true` while the conversation is handed off to a human (the bot should not reply). */
  handoff: boolean
  /** Inbound messages not yet read by an agent. */
  unread: number
  /** SLA deadline (epoch ms). */
  slaDueAt?: number
  /** Optimistic-concurrency version; bumped on every write. */
  version: number
  /** Epoch ms of the last write. */
  updatedAt: number
}

/** Internal note attached to a conversation; never sent to the contact. */
export interface InboxNote {
  id: string
  tenantId: string
  conversationId: string
  authorId: string
  body: string
  createdAt: number
}

/** Thrown when a mutation's `expectedVersion` no longer matches the stored conversation. */
export class InboxConflictError extends Error {
  constructor() {
    super('inbox conversation version conflict')
    this.name = 'InboxConflictError'
  }
}

/**
 * In-memory, tenant-isolated inbox. Every read returns a copy, so callers
 * cannot mutate stored state. Mutations other than {@link MemoryInbox.upsert} require
 * the caller's `expectedVersion` and fail with {@link InboxConflictError} on
 * mismatch, which prevents two agents from overwriting each other's handoff.
 */
export class MemoryInbox {
  private readonly conversations = new Map<string, InboxConversation>()
  private readonly notes = new Map<string, InboxNote[]>()

  /**
   * Create or merge a conversation without a version check. `unread` keeps
   * its previous value (or `0`) when omitted; `version` is bumped.
   */
  upsert(input: Omit<InboxConversation, 'version' | 'updatedAt' | 'unread'> & { unread?: number }): InboxConversation {
    const key = conversationKey(input.tenantId, input.id)
    const old = this.conversations.get(key)
    const value = {
      ...old,
      ...input,
      unread: input.unread ?? old?.unread ?? 0,
      version: (old?.version ?? 0) + 1,
      updatedAt: Date.now(),
    }
    this.conversations.set(key, value)
    return { ...value }
  }

  /** Copy of a conversation, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): InboxConversation | undefined {
    const value = this.conversations.get(conversationKey(tenantId, id))
    return value && { ...value }
  }

  /** Conversations of a tenant, optionally filtered by status and/or assignee (omitted fields match all). */
  list(tenantId: string, filter: Partial<Pick<InboxConversation, 'status' | 'assigneeId'>> = {}): InboxConversation[] {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.tenantId === tenantId && matchesFilter(conversation, filter))
      .map((conversation) => ({ ...conversation }))
  }

  /** Assign (or unassign with `undefined`) an agent. Requires the current version. */
  assign(tenantId: string, id: string, assigneeId: string | undefined, expectedVersion: number): InboxConversation {
    return this.mutate(tenantId, id, expectedVersion, (conversation) => ({ ...conversation, assigneeId }))
  }

  /** Toggle bot/human handoff. Requires the current version. */
  handoff(tenantId: string, id: string, enabled: boolean, expectedVersion: number): InboxConversation {
    return this.mutate(tenantId, id, expectedVersion, (conversation) => ({ ...conversation, handoff: enabled }))
  }

  /** Reset the unread counter. Requires the current version. */
  markRead(tenantId: string, id: string, expectedVersion: number): InboxConversation {
    return this.mutate(tenantId, id, expectedVersion, (conversation) => ({ ...conversation, unread: 0 }))
  }

  /**
   * Append an internal note. Throws when the conversation does not exist in
   * the tenant or when `body` is blank.
   */
  addNote(tenantId: string, conversationId: string, authorId: string, body: string): InboxNote {
    if (!this.conversations.has(conversationKey(tenantId, conversationId))) {
      throw new Error('conversation not found')
    }
    if (!body.trim()) throw new Error('note body is required')

    const note = {
      id: crypto.randomUUID(),
      tenantId,
      conversationId,
      authorId,
      body,
      createdAt: Date.now(),
    }
    const key = conversationKey(tenantId, conversationId)
    this.notes.set(key, [...(this.notes.get(key) ?? []), note])
    return { ...note }
  }

  /** Copies of a conversation's notes in insertion order (empty for unknown conversations). */
  listNotes(tenantId: string, conversationId: string): InboxNote[] {
    return (this.notes.get(conversationKey(tenantId, conversationId)) ?? []).map((note) => ({ ...note }))
  }

  /**
   * Project a ledger message into its conversation (keyed by `chatId`).
   * A missing `tenantId` maps to `'local'`. New conversations start `open`
   * without handoff; existing ones keep status, handoff, assignee and SLA.
   * Inbound messages increment `unread`; outbound ones leave it unchanged.
   */
  projectMessage(message: StoredMessage): InboxConversation {
    const tenantId = message.tenantId ?? 'local'
    const existing = this.get(tenantId, message.chatId)
    return this.upsert({
      tenantId,
      id: message.chatId,
      status: existing?.status ?? 'open',
      handoff: existing?.handoff ?? false,
      assigneeId: existing?.assigneeId,
      slaDueAt: existing?.slaDueAt,
      unread: (existing?.unread ?? 0) + (message.direction === 'inbound' ? 1 : 0),
    })
  }

  /** Compare-and-set: apply `fn` only when the stored version equals `expected`. */
  private mutate(
    tenantId: string,
    id: string,
    expected: number,
    fn: (conversation: InboxConversation) => InboxConversation,
  ): InboxConversation {
    const old = this.conversations.get(conversationKey(tenantId, id))
    if (!old) throw new Error('conversation not found')
    if (old.version !== expected) throw new InboxConflictError()

    const value = { ...fn(old), version: old.version + 1, updatedAt: Date.now() }
    this.conversations.set(conversationKey(tenantId, id), value)
    return { ...value }
  }
}

function matchesFilter(
  conversation: InboxConversation,
  filter: Partial<Pick<InboxConversation, 'status' | 'assigneeId'>>,
): boolean {
  return (!filter.status || conversation.status === filter.status) &&
    (!filter.assigneeId || conversation.assigneeId === filter.assigneeId)
}

/** Tenant-scoped map key (NUL-separated, so equal ids in different tenants never collide). */
function conversationKey(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`
}
