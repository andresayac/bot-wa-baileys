/**
 * Shared conformance suite for `@bot-wa/crm`'s `ContactStore`: tenant isolation, full
 * replacement and tag normalization, strict segment matching, bounded listings, copies
 * and consent updates that never lose a concurrent writer.
 * `MemoryContactStore` is the reference; `KvContactStore` must behave identically on
 * every backend.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the runner).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContactStore } from '../packages/crm/src/store.js'

export interface ContactStoreHarness {
  /** A fresh store using `clock` as its time source, and its teardown. */
  make(options: { clock: () => number }): Promise<{ store: ContactStore; teardown: () => Promise<void> }>
}

const T0 = 1_700_000_000_000

const input = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'a',
  id: 'u',
  channels: { wa: '1' },
  tags: ['vip'],
  attributes: { country: 'CO' },
  marketingConsent: true,
  ...overrides,
})

export function runContactStoreConformance(name: string, harness: ContactStoreHarness): void {
  describe(`${name} — ContactStore conformance`, () => {
    let store: ContactStore
    let teardown: () => Promise<void>
    let now = T0
    beforeEach(async () => {
      now = T0
      ;({ store, teardown } = await harness.make({ clock: () => now }))
    })
    afterEach(async () => { await teardown() })

    it('isolates tenants: the same contact id in two tenants are two contacts', async () => {
      const a = await store.upsert(input())
      await store.upsert(input({ tenantId: 'b', marketingConsent: false, tags: ['other'] }))
      expect(a).toEqual({ tenantId: 'a', id: 'u', channels: { wa: '1' }, tags: ['vip'], attributes: { country: 'CO' }, marketingConsent: true, updatedAt: T0 })
      expect(await store.get('b', 'u')).toMatchObject({ marketingConsent: false, tags: ['other'] })
      expect(await store.get('c', 'u')).toBeUndefined()
      expect((await store.segment('a', {})).map((c) => c.tenantId)).toEqual(['a'])
      await expect(store.setConsent('c', 'u', true)).rejects.toMatchObject({ name: 'ContactNotFoundError' })
    })

    it('upsert fully replaces the contact, deduplicating and sorting tags', async () => {
      await store.upsert(input({ tags: ['vip', 'beta', 'vip'], attributes: { country: 'CO', plan: 'pro' } }))
      expect(await store.get('a', 'u')).toMatchObject({ tags: ['beta', 'vip'], attributes: { country: 'CO', plan: 'pro' } })
      now += 7
      const replaced = await store.upsert(input({ tags: ['new'], attributes: { country: 'MX' }, channels: { sms: '2' } }))
      expect(replaced).toMatchObject({ tags: ['new'], attributes: { country: 'MX' }, channels: { sms: '2' }, updatedAt: T0 + 7 })
      expect(replaced.attributes).not.toHaveProperty('plan')
      expect(replaced.channels).not.toHaveProperty('wa')
    })

    it('segments by tags, attributes (strict equality) and consent', async () => {
      await store.upsert(input({ id: 'u1' }))
      now += 1
      await store.upsert(input({ id: 'u2', tags: ['vip', 'beta'], attributes: { country: 'CO', age: 30 } }))
      now += 1
      await store.upsert(input({ id: 'u3', tags: ['beta'], attributes: { age: '30' }, marketingConsent: false }))

      expect((await store.segment('a', { tagsAll: ['vip'] })).map((c) => c.id)).toEqual(['u2', 'u1'])
      expect((await store.segment('a', { tagsAll: ['vip', 'beta'] })).map((c) => c.id)).toEqual(['u2'])
      expect((await store.segment('a', { attributes: { age: 30 } })).map((c) => c.id)).toEqual(['u2'])
      expect((await store.segment('a', { attributes: { age: '30' } })).map((c) => c.id)).toEqual(['u3'])
      expect((await store.segment('a', { marketingConsent: false })).map((c) => c.id)).toEqual(['u3'])
      expect((await store.segment('a', { tagsAll: ['vip'], marketingConsent: true, attributes: { country: 'CO' } })).map((c) => c.id)).toEqual(['u2', 'u1'])
      expect(await store.segment('b', {})).toEqual([])
    })

    it('bounds the scan and the result, with actionable errors', async () => {
      for (let i = 0; i < 5; i++) {
        now += 1
        await store.upsert(input({ id: `u${i}`, tags: i < 2 ? ['vip'] : ['other'] }))
      }
      expect((await store.segment('a', {}, { limit: 2 })).map((c) => c.id)).toEqual(['u4', 'u3'])
      expect((await store.segment('a', { tagsAll: ['vip'] }, { scan: 3 })).map((c) => c.id)).toEqual([])
      expect((await store.segment('a', { tagsAll: ['vip'] }, { scan: 5 })).map((c) => c.id)).toEqual(['u1', 'u0'])
      expect(await store.segment('a', {}, { limit: 0 })).toEqual([])
      await expect(store.segment('a', {}, { limit: -1 })).rejects.toThrow(RangeError)
      await expect(store.segment('a', {}, { scan: 1.5 })).rejects.toThrow(RangeError)
    })

    it('updates consent without losing concurrent writers', async () => {
      await store.upsert(input())
      now += 1
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.setConsent('a', 'u', i % 2 === 0)),
      )
      expect(results).toHaveLength(20)
      expect(await store.get('a', 'u')).toMatchObject({ marketingConsent: expect.any(Boolean), updatedAt: T0 + 1 })
      await expect(store.setConsent('a', 'missing', true)).rejects.toMatchObject({ name: 'ContactNotFoundError' })
    })

    it('returns copies that cannot mutate stored state', async () => {
      const created = await store.upsert(input())
      created.tags.push('hacked')
      created.channels.wa = 'other'
      created.attributes.country = 'XX'
      expect(await store.get('a', 'u')).toMatchObject({ tags: ['vip'], channels: { wa: '1' }, attributes: { country: 'CO' } })
      const listed = (await store.segment('a', {}))[0]!
      listed.tags.push('hacked')
      expect((await store.segment('a', {}))[0]!.tags).toEqual(['vip'])
    })

    it('rejects empty tenant and contact ids', async () => {
      await expect(store.upsert(input({ tenantId: '' }))).rejects.toThrow(TypeError)
      await expect(store.upsert(input({ id: '' }))).rejects.toThrow(TypeError)
      await expect(store.segment('', {})).rejects.toThrow(TypeError)
      await expect(store.get('', 'u')).rejects.toThrow(TypeError)
    })
  })
}
