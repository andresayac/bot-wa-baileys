/**
 * Records of `@bot-wa/inbox`: conversations as agents see them, internal notes, the
 * inputs of the store operations and the errors they reject with.
 */

/** Lifecycle state of an inbox conversation. */
export type ConversationStatus = 'open' | 'pending' | 'resolved'

/** One conversation as seen by human agents, scoped to a tenant. */
export interface InboxConversation {
  tenantId: string
  /** Conversation id; `Inbox.projectMessage` uses the message `chatId`. */
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

/** Input of `InboxStore.upsert`: `unread` keeps its previous value (or `0`) when omitted. */
export type InboxUpsert = Omit<InboxConversation, 'version' | 'updatedAt' | 'unread'> & { unread?: number }

/** Fields an agent can change with `InboxStore.update` (`null` clears an optional field). */
export interface InboxPatch {
  status?: ConversationStatus
  assigneeId?: string | null
  handoff?: boolean
  unread?: number
  slaDueAt?: number | null
}

/** Options of `InboxStore.list`. */
export interface InboxListOptions {
  /** Only conversations in this status. */
  status?: ConversationStatus
  /** Only conversations assigned to this agent. */
  assigneeId?: string
  /** Maximum conversations returned (default 100). */
  limit?: number
  /**
   * How many of the most recently updated conversations the filters are applied to
   * (default 1000). `status: 'open' | 'pending'` scans only unresolved conversations,
   * so resolved history never pushes them out of the window.
   */
  scan?: number
}

/** Thrown when a mutation's `expectedVersion` no longer matches the stored conversation. */
export class InboxConflictError extends Error {
  constructor() {
    super('inbox conversation version conflict')
    this.name = 'InboxConflictError'
  }
}

/** Thrown when a conversation does not exist in that tenant. */
export class InboxNotFoundError extends Error {
  constructor() {
    super('conversation not found')
    this.name = 'InboxNotFoundError'
  }
}
