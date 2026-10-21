/**
 * MemoryContactStore — the in-RAM reference implementation of {@link ContactStore},
 * plus the pure helpers (normalization, segment matching, limits) both stores share.
 * Every read returns a copy; state is lost on restart (use `KvContactStore` to persist).
 */

import { assertTenantId } from '@botmesh/tenant-kv'
import type { ContactStore } from './store.js'
import {
  ContactNotFoundError,
  type Contact,
  type ContactInput,
  type ContactListOptions,
  type ContactSegment,
} from './types.js'

export interface MemoryContactStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
}

export const DEFAULT_LIST_LIMIT = 100
export const DEFAULT_SCAN = 1000

export function assertLimit(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback
  if (!(Number.isInteger(value) || value === Number.POSITIVE_INFINITY) || value < 0) throw new RangeError(`${what} must be a non-negative integer`)
  return value
}

export function assertContactIds(tenantId: string, id?: string): void {
  assertTenantId(tenantId)
  if (id !== undefined) assertTenantId(id, 'id')
}

/** Deep copy of a contact (tags, attributes and channels included). */
export function cloneContact(contact: Contact): Contact {
  return {
    ...contact,
    tags: [...contact.tags],
    attributes: { ...contact.attributes },
    channels: { ...contact.channels },
  }
}

/** The stored form of an upsert: tags deduplicated and sorted, maps copied, timestamp set. */
export function normalizeContact(input: ContactInput, now: number): Contact {
  assertContactIds(input.tenantId, input.id)
  return {
    tenantId: input.tenantId,
    id: input.id,
    channels: { ...input.channels },
    tags: [...new Set(input.tags)].sort(),
    attributes: { ...input.attributes },
    marketingConsent: input.marketingConsent === true,
    updatedAt: now,
  }
}

export function matchesSegment(contact: Contact, rule: ContactSegment): boolean {
  return matchesConsent(contact, rule) && matchesTags(contact, rule) && matchesAttributes(contact, rule)
}

function matchesConsent(contact: Contact, rule: ContactSegment): boolean {
  return rule.marketingConsent === undefined || contact.marketingConsent === rule.marketingConsent
}

function matchesTags(contact: Contact, rule: ContactSegment): boolean {
  return !rule.tagsAll || rule.tagsAll.every((tag) => contact.tags.includes(tag))
}

function matchesAttributes(contact: Contact, rule: ContactSegment): boolean {
  return !rule.attributes ||
    Object.entries(rule.attributes).every(([name, value]) => contact.attributes[name] === value)
}

/** Most recently updated first, ties by id. */
export function byRecency(a: Contact, b: Contact): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** NUL-separated key, so equal ids in different tenants never collide. */
export const contactKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`

export class MemoryContactStore implements ContactStore {
  private readonly contacts = new Map<string, Contact>()
  private readonly clock: () => number

  constructor(options: MemoryContactStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
  }

  async upsert(input: ContactInput): Promise<Contact> {
    const value = normalizeContact(input, this.clock())
    this.contacts.set(contactKey(value.tenantId, value.id), value)
    return cloneContact(value)
  }

  async get(tenantId: string, id: string): Promise<Contact | undefined> {
    assertContactIds(tenantId, id)
    const contact = this.contacts.get(contactKey(tenantId, id))
    return contact && cloneContact(contact)
  }

  async segment(tenantId: string, rule: ContactSegment, options: ContactListOptions = {}): Promise<Contact[]> {
    assertContactIds(tenantId)
    const limit = assertLimit(options.limit, DEFAULT_LIST_LIMIT, 'limit')
    const scan = assertLimit(options.scan, DEFAULT_SCAN, 'scan')
    return [...this.contacts.values()]
      .filter((contact) => contact.tenantId === tenantId)
      .sort(byRecency)
      .slice(0, scan)
      .filter((contact) => matchesSegment(contact, rule))
      .slice(0, limit)
      .map(cloneContact)
  }

  async setConsent(tenantId: string, id: string, marketingConsent: boolean): Promise<Contact> {
    assertContactIds(tenantId, id)
    const key = contactKey(tenantId, id)
    const contact = this.contacts.get(key)
    if (!contact) throw new ContactNotFoundError()
    const next: Contact = { ...contact, marketingConsent: marketingConsent === true, updatedAt: this.clock() }
    this.contacts.set(key, next)
    return cloneContact(next)
  }
}
