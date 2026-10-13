/**
 * @bot-wa/crm — in-memory prototype of a tenant-isolated contact directory.
 *
 * - {@link ContactDirectory} — contacts with per-channel addresses, tags,
 *   attributes and marketing consent, plus rule-based segments.
 *
 * Private prototype: state lives in RAM and is not published to npm.
 *
 * @example
 * ```ts
 * const contacts = new ContactDirectory()
 * contacts.upsert({
 *   tenantId: 'acme',
 *   id: 'person-1',
 *   channels: { whatsapp: '57300' },
 *   tags: ['vip'],
 *   attributes: { country: 'CO' },
 *   marketingConsent: true,
 * })
 * const recipients = contacts.segment('acme', { tagsAll: ['vip'], marketingConsent: true })
 * ```
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

/** Segment rule; every provided criterion must match (logical AND). */
export interface ContactSegment {
  /** Contact must carry all of these tags. */
  tagsAll?: readonly string[]
  /** Contact attributes must strictly equal (`===`) each of these values. */
  attributes?: Record<string, string | number | boolean>
  /** When set, contact consent must equal this value. */
  marketingConsent?: boolean
}

/**
 * In-memory, tenant-isolated contact directory. Every read returns a copy
 * (tags, attributes and channels included), so callers cannot mutate stored
 * state.
 */
export class ContactDirectory {
  private readonly contacts = new Map<string, Contact>()

  /**
   * Create or fully replace a contact (no merge with the previous value).
   * Tags are deduplicated and sorted; `updatedAt` is set to now.
   */
  upsert(input: Omit<Contact, 'updatedAt'>): Contact {
    const value = {
      ...input,
      tags: [...new Set(input.tags)].sort(),
      attributes: { ...input.attributes },
      channels: { ...input.channels },
      updatedAt: Date.now(),
    }
    this.contacts.set(contactKey(input.tenantId, input.id), value)
    return clone(value)
  }

  /** Copy of a contact, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): Contact | undefined {
    const contact = this.contacts.get(contactKey(tenantId, id))
    return contact && clone(contact)
  }

  /** Update marketing consent of an existing contact. Throws when it does not exist. */
  setConsent(tenantId: string, id: string, marketingConsent: boolean): Contact {
    const contact = this.require(tenantId, id)
    return this.upsert({ ...contact, marketingConsent })
  }

  /** Contacts of a tenant matching every criterion of `rule`. */
  segment(tenantId: string, rule: ContactSegment): Contact[] {
    return [...this.contacts.values()]
      .filter((contact) => contact.tenantId === tenantId && matches(contact, rule))
      .map(clone)
  }

  private require(tenantId: string, id: string): Contact {
    const contact = this.contacts.get(contactKey(tenantId, id))
    if (!contact) throw new Error('contact not found')
    return contact
  }
}

function matches(contact: Contact, rule: ContactSegment): boolean {
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

/** Tenant-scoped map key (NUL-separated, so equal ids in different tenants never collide). */
function contactKey(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`
}

function clone(contact: Contact): Contact {
  return {
    ...contact,
    tags: [...contact.tags],
    attributes: { ...contact.attributes },
    channels: { ...contact.channels },
  }
}
