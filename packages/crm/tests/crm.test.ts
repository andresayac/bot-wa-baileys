import { describe, expect, it } from 'vitest'

import { ContactDirectory, type Contact } from '../src/index.js'

function contact(overrides: Partial<Omit<Contact, 'updatedAt'>> = {}): Omit<Contact, 'updatedAt'> {
  return {
    tenantId: 'a',
    id: 'u',
    channels: { wa: '1' },
    tags: ['vip'],
    attributes: { country: 'CO' },
    marketingConsent: true,
    ...overrides,
  }
}

describe('contacts', () => {
  it('segments and updates consent without crossing tenants', () => {
    const crm = new ContactDirectory()
    crm.upsert(contact({ tenantId: 'a', channels: { wa: '1' } }))
    crm.upsert(contact({ tenantId: 'b', channels: { wa: '2' } }))

    expect(crm.segment('a', { tagsAll: ['vip'], marketingConsent: true })).toHaveLength(1)
    expect(crm.setConsent('a', 'u', false)).toMatchObject({ marketingConsent: false })
    expect(crm.segment('b', { marketingConsent: true })).toHaveLength(1)
  })

  it('deduplicates and sorts tags, replacing the previous contact on upsert', () => {
    const crm = new ContactDirectory()
    crm.upsert(contact({ tags: ['vip', 'beta', 'vip'], attributes: { country: 'CO', plan: 'pro' } }))

    expect(crm.get('a', 'u')).toMatchObject({ tags: ['beta', 'vip'] })

    crm.upsert(contact({ tags: ['new'], attributes: { country: 'MX' } }))
    expect(crm.get('a', 'u')).toMatchObject({ tags: ['new'], attributes: { country: 'MX' } })
    expect(crm.get('a', 'u')?.attributes).not.toHaveProperty('plan')
  })

  it('matches attributes by strict equality', () => {
    const crm = new ContactDirectory()
    crm.upsert(contact({ attributes: { age: 30 } }))

    expect(crm.segment('a', { attributes: { age: 30 } })).toHaveLength(1)
    expect(crm.segment('a', { attributes: { age: '30' } })).toEqual([])
  })

  it('throws when changing consent of an unknown contact', () => {
    const crm = new ContactDirectory()
    crm.upsert(contact({ tenantId: 'a' }))

    expect(() => crm.setConsent('b', 'u', true)).toThrow('contact not found')
    expect(crm.get('b', 'u')).toBeUndefined()
  })

  it('returns copies that cannot mutate stored state', () => {
    const crm = new ContactDirectory()
    const created = crm.upsert(contact())

    created.tags.push('hacked')
    created.channels.wa = 'other'
    crm.get('a', 'u')!.attributes.country = 'XX'

    expect(crm.get('a', 'u')).toMatchObject({ tags: ['vip'], channels: { wa: '1' }, attributes: { country: 'CO' } })
  })
})
