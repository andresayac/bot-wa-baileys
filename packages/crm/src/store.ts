/**
 * ContactStore — the storage contract of `@botmesh/crm`. `MemoryContactStore` is the
 * reference implementation and `KvContactStore` persists through any `DurableKv` of
 * `@botmesh/core`; both pass `test-utils/contact-store-conformance.ts`.
 *
 * `upsert` replaces the whole contact (tags are normalized), `setConsent` is a
 * compare-and-set loop that never loses another writer's changes, and every read
 * returns a copy.
 */

import type { Contact, ContactInput, ContactListOptions, ContactSegment } from './types.js'

export interface ContactStore {
  /** Create or fully replace a contact. Tags are deduplicated and sorted; `updatedAt` is set to now. */
  upsert(input: ContactInput): Promise<Contact>
  /** Copy of a contact, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): Promise<Contact | undefined>
  /** Contacts of a tenant matching every criterion of `rule`, most recently updated first. */
  segment(tenantId: string, rule: ContactSegment, options?: ContactListOptions): Promise<Contact[]>
  /**
   * Update marketing consent of an existing contact.
   * @throws {ContactNotFoundError} when it does not exist in that tenant.
   */
  setConsent(tenantId: string, id: string, marketingConsent: boolean): Promise<Contact>
}
