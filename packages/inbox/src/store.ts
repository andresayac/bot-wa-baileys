/**
 * InboxStore — the storage contract of `@bot-wa/inbox`. `MemoryInboxStore` is the
 * reference implementation and `KvInboxStore` persists through any `DurableKv` of
 * `@bot-wa/core`; both pass `test-utils/inbox-store-conformance.ts`.
 *
 * Every mutation of an existing conversation is a compare-and-set on its `version`
 * (atomic in the backend: two agents can never silently overwrite each other), and
 * every read returns a copy.
 */

import type { StoredMessage } from '@bot-wa/core'
import type { InboxConversation, InboxListOptions, InboxNote, InboxPatch, InboxUpsert } from './types.js'

export interface InboxStore {
  /**
   * Create or merge a conversation. Merging into an existing one requires its current
   * `expectedVersion`; creating accepts it omitted or `0` (`0` = create only).
   * @throws {InboxConflictError} on any mismatch (nothing is written).
   */
  upsert(input: InboxUpsert, expectedVersion?: number): Promise<InboxConversation>
  /** Copy of a conversation, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): Promise<InboxConversation | undefined>
  /** Conversations of a tenant, most recently updated first, filtered within a bounded scan (see {@link InboxListOptions}). */
  list(tenantId: string, options?: InboxListOptions): Promise<InboxConversation[]>
  /**
   * Apply `patch` to a conversation whose stored version is `expectedVersion`.
   * @throws {InboxNotFoundError} when it does not exist; {@link InboxConflictError} on a stale version.
   */
  update(tenantId: string, id: string, expectedVersion: number, patch: InboxPatch): Promise<InboxConversation>
  /**
   * Fold a ledger message into its conversation (keyed by `chatId`, tenant `message.tenantId ?? 'local'`):
   * an inbound message bumps `unread` on top of the latest stored state (agent fields are never
   * reverted); a new conversation starts `open` without handoff.
   * @throws {TypeError} when the message carries neither `direction` nor `fromMe` (nothing is written).
   */
  applyMessage(message: StoredMessage): Promise<InboxConversation>
  /**
   * Append an internal note.
   * @throws {InboxNotFoundError} when the conversation does not exist in the tenant; `Error` when `body` is blank.
   */
  addNote(tenantId: string, conversationId: string, authorId: string, body: string): Promise<InboxNote>
  /** Notes of a conversation in creation order (at most `limit`, default 100). */
  listNotes(tenantId: string, conversationId: string, options?: { limit?: number }): Promise<InboxNote[]>
}
