/**
 * Records of `@botmesh/crm`: contacts, segment rules, store inputs and the errors the
 * directory rejects with.
 */

/** A person known to a tenant, reachable on one or more channels. */
export interface Contact {
  tenantId: string
  id: string
  /** Channel name → address on that channel (e.g. `{ whatsapp: '57300...' }`). */
  channels: Record<string, string>
  /** Tags, stored deduplicated and sorted. */
  tags: string[]
  attributes: Record<string, string | number | boolean>
  /** Opt-in for marketing messages only; it does not cover transactional messages. */
  marketingConsent: boolean
  /** Epoch ms of the last write. */
  updatedAt: number
}

/** Input of {@link ContactStore.upsert}: the full contact without its timestamp. */
export type ContactInput = Omit<Contact, 'updatedAt'>

/** Segment rule; every provided criterion must match (logical AND). */
export interface ContactSegment {
  /** Contact must carry all of these tags. */
  tagsAll?: readonly string[]
  /** Contact attributes must strictly equal (`===`) each of these values. */
  attributes?: Record<string, string | number | boolean>
  /** When set, contact consent must equal this value. */
  marketingConsent?: boolean
}

/** Options of {@link ContactStore.segment}. */
export interface ContactListOptions {
  /** Maximum contacts returned (default 100). */
  limit?: number
  /** How many of the most recently updated contacts are scanned by the filters (default 1000). */
  scan?: number
}

/** Thrown when a contact does not exist in that tenant. */
export class ContactNotFoundError extends Error {
  constructor() {
    super('contact not found')
    this.name = 'ContactNotFoundError'
  }
}
