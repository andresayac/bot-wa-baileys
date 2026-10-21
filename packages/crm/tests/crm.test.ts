import { describe, expect, it } from 'vitest'
import { MemoryKv } from '@bot-wa/core'

import { ContactDirectory, ContactNotFoundError, KvContactStore, MemoryContactStore, type ContactInput } from '../src/index.js'

function contact(overrides: Partial<ContactInput> = {}): ContactInput {
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

const stores = [
  ['MemoryContactStore', () => new ContactDirectory(new MemoryContactStore({ clock: () => 1_000 }))],
  ['KvContactStore', () => new ContactDirectory(new KvContactStore(new MemoryKv(), { clock: () => 1_000 }))],
] as const

describe.each(stores)('ContactDirectory over %s', (_name, make) => {
  it('segments and updates consent without crossing tenants', async () => {
    const crm = make()
    await crm.upsert(contact({ tenantId: 'a', channels: { wa: '1' } }))
    await crm.upsert(contact({ tenantId: 'b', channels: { wa: '2' } }))

    expect(await crm.segment('a', { tagsAll: ['vip'], marketingConsent: true })).toHaveLength(1)
    expect(await crm.setConsent('a', 'u', false)).toMatchObject({ marketingConsent: false })
    expect(await crm.segment('b', { marketingConsent: true })).toHaveLength(1)
  })

  it('deduplicates and sorts tags, replacing the previous contact on upsert', async () => {
    const crm = make()
    await crm.upsert(contact({ tags: ['vip', 'beta', 'vip'], attributes: { country: 'CO', plan: 'pro' } }))

    expect(await crm.get('a', 'u')).toMatchObject({ tags: ['beta', 'vip'] })

    await crm.upsert(contact({ tags: ['new'], attributes: { country: 'MX' } }))
    expect(await crm.get('a', 'u')).toMatchObject({ tags: ['new'], attributes: { country: 'MX' } })
    expect((await crm.get('a', 'u'))?.attributes).not.toHaveProperty('plan')
  })

  it('matches attributes by strict equality', async () => {
    const crm = make()
    await crm.upsert(contact({ attributes: { age: 30 } }))

    expect(await crm.segment('a', { attributes: { age: 30 } })).toHaveLength(1)
    expect(await crm.segment('a', { attributes: { age: '30' } })).toEqual([])
  })

  it('throws when changing consent of an unknown contact', async () => {
    const crm = make()
    await crm.upsert(contact({ tenantId: 'a' }))

    await expect(crm.setConsent('b', 'u', true)).rejects.toThrow('contact not found')
    await expect(crm.setConsent('b', 'u', true)).rejects.toBeInstanceOf(ContactNotFoundError)
    expect(await crm.get('b', 'u')).toBeUndefined()
  })

  it('returns copies that cannot mutate stored state', async () => {
    const crm = make()
    const created = await crm.upsert(contact())

    created.tags.push('hacked')
    created.channels.wa = 'other'
    ;(await crm.get('a', 'u'))!.attributes.country = 'XX'

    expect(await crm.get('a', 'u')).toMatchObject({ tags: ['vip'], channels: { wa: '1' }, attributes: { country: 'CO' } })
  })
})
