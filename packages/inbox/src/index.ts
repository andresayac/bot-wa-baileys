/**
 * @botmesh/inbox — tenant-isolated omnichannel inbox: conversations with optimistic
 * concurrency (CAS on `version`), assignment, bot/human handoff, unread counters, SLA,
 * internal notes and the projection of core `StoredMessage`s from the message ledger.
 *
 * - {@link Inbox} — the agent-facing facade over an {@link InboxStore}.
 * - {@link MemoryInboxStore} — the in-RAM reference store (default).
 * - {@link KvInboxStore} — persisted through any `DurableKv` of `@botmesh/core`
 *   (SQLite, PostgreSQL, Redis, file) via `@botmesh/tenant-kv`.
 * - {@link attachInbox} — projects a running bot's traffic into the inbox.
 *
 * Private package: not published to npm.
 *
 * @example
 * ```ts
 * const inbox = new Inbox(new KvInboxStore(new PostgresDurableKv({ pool })))
 * const conversation = await inbox.projectMessage(storedMessage)
 * const assigned = await inbox.assign('acme', conversation.id, 'agent-7', conversation.version)
 * await inbox.handoff('acme', assigned.id, true, assigned.version)
 * ```
 */

export { Inbox } from './inbox.js'
export { MemoryInboxStore } from './memory.js'
export type { MemoryInboxStoreOptions } from './memory.js'
export { KvInboxStore } from './kv.js'
export type { KvInboxStoreOptions } from './kv.js'
export type { InboxStore } from './store.js'
export { attachInbox, inboxProjectionPlugin } from './bot.js'
export type { AttachInboxOptions } from './bot.js'
export { InboxConflictError, InboxNotFoundError } from './types.js'
export type { ConversationStatus, InboxConversation, InboxNote, InboxUpsert, InboxPatch, InboxListOptions } from './types.js'
