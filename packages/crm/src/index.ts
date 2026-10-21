/**
 * @botmesh/crm — tenant-isolated contact directory: contacts with per-channel
 * addresses, tags, attributes and marketing consent, plus rule-based segments.
 *
 * - {@link ContactDirectory} — the agent-facing facade over a {@link ContactStore}.
 * - {@link MemoryContactStore} — the in-RAM reference store (default).
 * - {@link KvContactStore} — persisted through any `DurableKv` of `@botmesh/core`
 *   (SQLite, PostgreSQL, Redis, file) via `@botmesh/tenant-kv`.
 *
 * Private package: not published to npm.
 *
 * @example
 * ```ts
 * const contacts = new ContactDirectory(new KvContactStore(new PostgresDurableKv({ pool })))
 * await contacts.upsert({
 *   tenantId: 'acme',
 *   id: 'person-1',
 *   channels: { whatsapp: '57300' },
 *   tags: ['vip'],
 *   attributes: { country: 'CO' },
 *   marketingConsent: true,
 * })
 * const recipients = await contacts.segment('acme', { tagsAll: ['vip'], marketingConsent: true })
 * ```
 */

export { ContactDirectory } from './crm.js'
export { MemoryContactStore } from './memory.js'
export type { MemoryContactStoreOptions } from './memory.js'
export { KvContactStore } from './kv.js'
export type { KvContactStoreOptions } from './kv.js'
export type { ContactStore } from './store.js'
export { ContactNotFoundError } from './types.js'
export type { Contact, ContactInput, ContactSegment, ContactListOptions } from './types.js'
