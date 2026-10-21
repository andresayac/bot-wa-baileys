/**
 * ContactDirectory — the agent-facing facade over a {@link ContactStore}: contacts with
 * per-channel addresses, tags, attributes and marketing consent, plus rule-based
 * segments. Without a store it keeps everything in memory ({@link MemoryContactStore});
 * give it a `KvContactStore` to persist.
 */

import { MemoryContactStore } from './memory.js'
import type { ContactStore } from './store.js'
import type { Contact, ContactInput, ContactListOptions, ContactSegment } from './types.js'

export class ContactDirectory {
  constructor(readonly store: ContactStore = new MemoryContactStore()) {}

  /**
   * Create or fully replace a contact (no merge with the previous value).
   * Tags are deduplicated and sorted; `updatedAt` is set to now.
   */
  upsert(input: ContactInput): Promise<Contact> {
    return this.store.upsert(input)
  }

  /** Copy of a contact, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): Promise<Contact | undefined> {
    return this.store.get(tenantId, id)
  }

  /** Update marketing consent of an existing contact. Rejects with `ContactNotFoundError` when it does not exist. */
  setConsent(tenantId: string, id: string, marketingConsent: boolean): Promise<Contact> {
    return this.store.setConsent(tenantId, id, marketingConsent)
  }

  /** Contacts of a tenant matching every criterion of `rule`. */
  segment(tenantId: string, rule: ContactSegment, options?: ContactListOptions): Promise<Contact[]> {
    return this.store.segment(tenantId, rule, options)
  }
}
