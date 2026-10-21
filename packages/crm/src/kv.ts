/**
 * KvContactStore — {@link ContactStore} persisted through any `DurableKv` of
 * `@botmesh/core` (SQLite, PostgreSQL, Redis, file or memory) via `@botmesh/tenant-kv`.
 *
 * One table per tenant, `product/crm/contact/<tenant>`: id = contact id, `all` index =
 * most recently updated first. `upsert` replaces the document, `setConsent` is a
 * compare-and-set loop (a concurrent writer is retried, never overwritten), and reads
 * validate the stored document instead of trusting it.
 */

import type { DurableKv } from '@botmesh/core'
import { TenantDocs } from '@botmesh/tenant-kv'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SCAN,
  assertContactIds,
  assertLimit,
  cloneContact,
  matchesSegment,
  normalizeContact,
} from './memory.js'
import type { ContactStore } from './store.js'
import { ContactNotFoundError, type Contact, type ContactInput, type ContactListOptions, type ContactSegment } from './types.js'

export interface KvContactStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
  /** Compare-and-set retries of `setConsent` (default 32). */
  attempts?: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isAttr = (v: unknown): v is string | number | boolean => isString(v) || typeof v === 'number' || typeof v === 'boolean'

function parseContact(value: unknown): Contact {
  if (!isRecord(value)) throw new TypeError('contact is not an object')
  const { tenantId, id, channels, tags, attributes, marketingConsent, updatedAt } = value
  if (!isString(tenantId) || !isString(id) || typeof marketingConsent !== 'boolean' || typeof updatedAt !== 'number') {
    throw new TypeError('bad contact')
  }
  if (!isRecord(channels) || !Object.values(channels).every(isString)) throw new TypeError('bad contact channels')
  if (!Array.isArray(tags) || !tags.every(isString)) throw new TypeError('bad contact tags')
  if (!isRecord(attributes) || !Object.values(attributes).every(isAttr)) throw new TypeError('bad contact attributes')
  return {
    tenantId,
    id,
    channels: { ...(channels as Record<string, string>) },
    tags: [...tags],
    attributes: { ...(attributes as Record<string, string | number | boolean>) },
    marketingConsent,
    updatedAt,
  }
}

const backoff = (attempt: number): Promise<void> => {
  if (attempt === 0) return Promise.resolve()
  const ms = Math.random() * Math.min(64, 2 ** attempt)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class KvContactStore implements ContactStore {
  private readonly contacts: TenantDocs<Contact>
  private readonly clock: () => number
  private readonly attempts: number

  constructor(kv: DurableKv, options: KvContactStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.attempts = options.attempts ?? 32
    if (!Number.isInteger(this.attempts) || this.attempts < 1) throw new RangeError('attempts must be a positive integer')
    this.contacts = new TenantDocs<Contact>(kv, {
      family: ['crm', 'contact'],
      parse: parseContact,
      order: (contact) => -contact.updatedAt,
    })
  }

  async upsert(input: ContactInput): Promise<Contact> {
    const contact = normalizeContact(input, this.clock())
    const table = this.contacts.in(contact.tenantId)
    const current = await table.get(contact.id)
    const written = current ? await table.replace(contact.id, current.version, contact) : await table.insert(contact.id, contact)
    if (!written) throw new Error('contact write lost its compare-and-set')
    return cloneContact(written.doc)
  }

  async get(tenantId: string, id: string): Promise<Contact | undefined> {
    assertContactIds(tenantId, id)
    const entry = await this.contacts.in(tenantId).get(id)
    return entry && cloneContact(entry.doc)
  }

  async segment(tenantId: string, rule: ContactSegment, options: ContactListOptions = {}): Promise<Contact[]> {
    assertContactIds(tenantId)
    const limit = assertLimit(options.limit, DEFAULT_LIST_LIMIT, 'limit')
    const scan = assertLimit(options.scan, DEFAULT_SCAN, 'scan')
    const candidates = await this.contacts.in(tenantId).list({ limit: scan })
    return candidates.filter((contact) => matchesSegment(contact, rule)).slice(0, limit).map(cloneContact)
  }

  async setConsent(tenantId: string, id: string, marketingConsent: boolean): Promise<Contact> {
    assertContactIds(tenantId, id)
    const table = this.contacts.in(tenantId)
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await backoff(attempt)
      const current = await table.get(id)
      if (!current) throw new ContactNotFoundError()
      const next: Contact = { ...current.doc, marketingConsent: marketingConsent === true, updatedAt: this.clock() }
      const written = await table.replace(id, current.version, next)
      if (written) return cloneContact(written.doc)
    }
    throw new Error(`too much contention on contact ${JSON.stringify(id)} after ${this.attempts} attempts`)
  }
}
