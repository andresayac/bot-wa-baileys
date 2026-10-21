/**
 * Shared conformance suite for `@bot-wa/campaigns`'s `CampaignStore`: tenant/campaign
 * isolation, per-recipient caps, reservation TTLs, settlement (sent counts, failed
 * releases), rejection of unknown/settled deliveries and concurrency.
 * `MemoryCampaignStore` is the reference; `KvCampaignStore` must behave identically on
 * every backend.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the
 * runner and the harness provides the delivery-id codec).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReserveInput } from '../packages/campaigns/src/types.js'
import type { CampaignStore } from '../packages/campaigns/src/store.js'

export interface CampaignStoreHarness {
  /** A fresh store using `clock` as its time source, and its teardown. */
  make(options: { clock: () => number }): Promise<{ store: CampaignStore; teardown: () => Promise<void> }>
  /** The package's delivery-id codec (`makeDeliveryId`). */
  deliveryId(tenantId: string, campaignId: string, recipientId: string): string
}

const T0 = 1_700_000_000_000
const TTL = 60_000

export function runCampaignStoreConformance(name: string, harness: CampaignStoreHarness): void {
  describe(`${name} — CampaignStore conformance`, () => {
    let store: CampaignStore
    let teardown: () => Promise<void>
    let now = T0
    beforeEach(async () => {
      now = T0
      ;({ store, teardown } = await harness.make({ clock: () => now }))
    })
    afterEach(async () => { await teardown() })

    const reserve = (overrides: Partial<ReserveInput> = {}): Promise<'reserved' | 'duplicate' | 'limit'> => {
      const input = { tenantId: 'a', campaignId: 'sale', recipientId: 'r1', maxPerRecipient: 1, now, ttlMs: TTL, ...overrides }
      const deliveryId = overrides.deliveryId ?? harness.deliveryId(input.tenantId, input.campaignId, input.recipientId)
      return store.reserve({ ...input, deliveryId })
    }

    it('isolates tenants and campaigns: the same recipient reserves once per campaign', async () => {
      expect(await reserve()).toBe('reserved')
      expect(await reserve({ campaignId: 'other' })).toBe('reserved')
      expect(await reserve({ tenantId: 'b' })).toBe('reserved')
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(0)
      expect(await store.sentCount('b', 'sale', 'r1')).toBe(0)
      expect(await store.sentCount('c', 'sale', 'r1')).toBe(0)
    })

    it('reserves up to the cap, counts sends and never double-settles', async () => {
      const first = harness.deliveryId('a', 'sale', 'r1')
      expect(await reserve({ deliveryId: first })).toBe('reserved')
      expect(await reserve()).toBe('duplicate')
      const sent = await store.settle(first, { state: 'sent' }, { now: now + 1 })
      expect(sent).toEqual({ tenantId: 'a', campaignId: 'sale', recipientId: 'r1', deliveryId: first, state: 'sent' })
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(1)
      expect(await reserve()).toBe('duplicate')
      await expect(store.settle(first, { state: 'sent' })).rejects.toMatchObject({ name: 'UnknownDeliveryError' })
      await expect(store.settle(first, { state: 'failed' })).rejects.toMatchObject({ name: 'UnknownDeliveryError' })
    })

    it('lets maxPerRecipient above 1 be used by successive sends', async () => {
      const first = harness.deliveryId('a', 'sale', 'r1')
      expect(await reserve({ maxPerRecipient: 2, deliveryId: first })).toBe('reserved')
      const second = harness.deliveryId('a', 'sale', 'r1')
      expect(await reserve({ maxPerRecipient: 2, deliveryId: second })).toBe('reserved')
      expect(await reserve({ maxPerRecipient: 2 })).toBe('duplicate')
      await store.settle(first, { state: 'sent' })
      await store.settle(second, { state: 'sent' })
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(2)
    })

    it('releases the slot on failure so the recipient can be planned again', async () => {
      const first = harness.deliveryId('a', 'sale', 'r1')
      await reserve({ deliveryId: first })
      const failed = await store.settle(first, { state: 'failed', error: 'timeout' })
      expect(failed).toMatchObject({ state: 'failed', error: 'timeout' })
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(0)
      expect(await reserve()).toBe('reserved')
    })

    it('pauses everyone when maxPerRecipient is 0', async () => {
      expect(await reserve({ maxPerRecipient: 0 })).toBe('limit')
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(0)
    })

    it('frees a reservation that expires without being settled', async () => {
      const first = harness.deliveryId('a', 'sale', 'r1')
      await reserve({ deliveryId: first })
      now = T0 + TTL + 1
      const second = harness.deliveryId('a', 'sale', 'r1')
      expect(await reserve({ deliveryId: second })).toBe('reserved')
      // The expired delivery is gone: settling it now is rejected.
      await expect(store.settle(first, { state: 'sent' })).rejects.toMatchObject({ name: 'UnknownDeliveryError' })
      await store.settle(second, { state: 'sent' })
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(1)
    })

    it('concurrent reservations of one recipient: exactly one wins the cap', async () => {
      const ids = Array.from({ length: 20 }, () => harness.deliveryId('a', 'sale', 'r1'))
      const outcomes = await Promise.all(ids.map((deliveryId) => store.reserve({ tenantId: 'a', campaignId: 'sale', recipientId: 'r1', deliveryId, maxPerRecipient: 1, now, ttlMs: TTL })))
      expect(outcomes.filter((outcome) => outcome === 'reserved')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(19)
      const winner = ids[outcomes.indexOf('reserved')]!
      await store.settle(winner, { state: 'sent' })
      expect(await store.sentCount('a', 'sale', 'r1')).toBe(1)
    })

    it('rejects malformed inputs and unknown delivery ids', async () => {
      await expect(reserve({ maxPerRecipient: -1 })).rejects.toThrow(RangeError)
      await expect(reserve({ maxPerRecipient: 1.5 })).rejects.toThrow(RangeError)
      await expect(reserve({ ttlMs: 0 })).rejects.toThrow(RangeError)
      await expect(reserve({ tenantId: '' })).rejects.toThrow(TypeError)
      await expect(reserve({ campaignId: '' })).rejects.toThrow(TypeError)
      await expect(reserve({ recipientId: '' })).rejects.toThrow(TypeError)
      await expect(reserve({ deliveryId: '' })).rejects.toThrow(TypeError)
      await expect(store.settle('not-a-delivery-id', { state: 'sent' })).rejects.toMatchObject({ name: 'UnknownDeliveryError' })
      await expect(store.settle(harness.deliveryId('a', 'sale', 'missing'), { state: 'sent' })).rejects.toMatchObject({ name: 'UnknownDeliveryError' })
      await expect(store.sentCount('', 'sale', 'r1')).rejects.toThrow(TypeError)
    })
  })
}
