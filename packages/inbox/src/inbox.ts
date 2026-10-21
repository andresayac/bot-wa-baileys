/**
 * Inbox — the agent-facing facade over an {@link InboxStore}: assignment, handoff,
 * read state, resolution, SLA, notes and the projection of ledger messages.
 */

import type { StoredMessage } from '@botmesh/core'
import { MemoryInboxStore } from './memory.js'
import type { InboxStore } from './store.js'
import type { InboxConversation, InboxListOptions, InboxNote, InboxUpsert } from './types.js'

/**
 * Tenant-isolated inbox over a store. Without a store it keeps everything in memory
 * ({@link MemoryInboxStore}); give it a `KvInboxStore` to persist. Every mutation of an
 * existing conversation requires the caller's `expectedVersion` and fails with
 * `InboxConflictError` on mismatch, which prevents two agents from overwriting each
 * other's handoff. {@link Inbox.projectMessage} applies its increment atomically.
 */
export class Inbox {
  constructor(readonly store: InboxStore = new MemoryInboxStore()) {}

  /** See {@link InboxStore.upsert}. */
  upsert(input: InboxUpsert, expectedVersion?: number): Promise<InboxConversation> {
    return this.store.upsert(input, expectedVersion)
  }

  /** Copy of a conversation, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): Promise<InboxConversation | undefined> {
    return this.store.get(tenantId, id)
  }

  /** Conversations of a tenant, most recently updated first (see {@link InboxListOptions}). */
  list(tenantId: string, options?: InboxListOptions): Promise<InboxConversation[]> {
    return this.store.list(tenantId, options)
  }

  /** Assign (or unassign with `undefined`) an agent. Requires the current version. */
  assign(tenantId: string, id: string, assigneeId: string | undefined, expectedVersion: number): Promise<InboxConversation> {
    return this.store.update(tenantId, id, expectedVersion, { assigneeId: assigneeId ?? null })
  }

  /** Toggle bot/human handoff. Requires the current version. */
  handoff(tenantId: string, id: string, enabled: boolean, expectedVersion: number): Promise<InboxConversation> {
    return this.store.update(tenantId, id, expectedVersion, { handoff: enabled })
  }

  /** Reset the unread counter. Requires the current version. */
  markRead(tenantId: string, id: string, expectedVersion: number): Promise<InboxConversation> {
    return this.store.update(tenantId, id, expectedVersion, { unread: 0 })
  }

  /** Mark the conversation `resolved`. Requires the current version. */
  resolve(tenantId: string, id: string, expectedVersion: number): Promise<InboxConversation> {
    return this.store.update(tenantId, id, expectedVersion, { status: 'resolved' })
  }

  /** Mark the conversation `open` again. Requires the current version. */
  reopen(tenantId: string, id: string, expectedVersion: number): Promise<InboxConversation> {
    return this.store.update(tenantId, id, expectedVersion, { status: 'open' })
  }

  /** Set (or clear with `undefined`) the SLA deadline. Requires the current version. */
  setSla(tenantId: string, id: string, slaDueAt: number | undefined, expectedVersion: number): Promise<InboxConversation> {
    return this.store.update(tenantId, id, expectedVersion, { slaDueAt: slaDueAt ?? null })
  }

  /** Append an internal note (see {@link InboxStore.addNote}). */
  addNote(tenantId: string, conversationId: string, authorId: string, body: string): Promise<InboxNote> {
    return this.store.addNote(tenantId, conversationId, authorId, body)
  }

  /** Notes of a conversation in creation order. */
  listNotes(tenantId: string, conversationId: string, options?: { limit?: number }): Promise<InboxNote[]> {
    return this.store.listNotes(tenantId, conversationId, options)
  }

  /**
   * Project a ledger message into its conversation (keyed by `chatId`). A missing
   * `tenantId` maps to `'local'`. New conversations start `open` without handoff;
   * existing ones keep status, handoff, assignee and SLA. Inbound messages increment
   * `unread`; outbound ones leave it unchanged.
   *
   * The direction comes from `message.direction`, or from `fromMe` when the ledger
   * entry predates `direction` (`fromMe: true` is outbound). A message with neither is
   * rejected with a `TypeError` and nothing is written.
   */
  projectMessage(message: StoredMessage): Promise<InboxConversation> {
    return this.store.applyMessage(message)
  }
}
