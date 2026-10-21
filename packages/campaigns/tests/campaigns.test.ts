import { describe, expect, it } from 'vitest'
import { Bot, MemoryKv, RecipientUnreachableError, type OutboundContent, type SendOptions, type SendResult } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'

import {
  CampaignPlanner,
  KvCampaignStore,
  MemoryCampaignStore,
  UnknownDeliveryError,
  sendCampaign,
  type CampaignRecipient,
} from '../src/index.js'

function recipient(overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return { id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'], ...overrides }
}

const stores = [
  ['MemoryCampaignStore', () => new CampaignPlanner(new MemoryCampaignStore({ clock: () => 1_000 }))],
  ['KvCampaignStore', () => new CampaignPlanner(new KvCampaignStore(new MemoryKv(), { clock: () => 1_000 }))],
] as const

describe.each(stores)('CampaignPlanner over %s', (_name, make) => {
  it('honors consent, segments and deduplicates per tenant', async () => {
    const planner = make()
    const campaign = { id: 'sale', tenantId: 'a', requiredTags: ['vip'] }

    const result = await planner.plan(campaign, [
      { id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'] },
      { id: '2', tenantId: 'a', channel: 'wa', optedIn: false },
      { id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'] },
      { id: '3', tenantId: 'b', channel: 'wa', optedIn: true, tags: ['vip'] },
    ])

    expect(result.map((x) => x.state)).toEqual(['queued', 'skipped', 'skipped', 'skipped'])
    expect(
      (await planner.plan(campaign, [{ id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'] }]))[0],
    ).toMatchObject({ reason: 'duplicate' })
  })

  it('explains every skip with a reason', async () => {
    const planner = make()
    const campaign = { id: 'sale', tenantId: 'a', requiredTags: ['vip'] }

    const result = await planner.plan(campaign, [
      recipient({ id: '1' }),
      recipient({ id: '2', optedIn: false }),
      recipient({ id: '3', tags: [] }),
      recipient({ id: '1' }),
      recipient({ id: '4', tenantId: 'b' }),
    ])

    expect(result).toEqual([
      { campaignId: 'sale', tenantId: 'a', recipientId: '1', state: 'queued', deliveryId: expect.any(String) },
      { campaignId: 'sale', tenantId: 'a', recipientId: '2', state: 'skipped', reason: 'opt_out' },
      { campaignId: 'sale', tenantId: 'a', recipientId: '3', state: 'skipped', reason: 'segment' },
      { campaignId: 'sale', tenantId: 'a', recipientId: '1', state: 'skipped', reason: 'duplicate' },
      { campaignId: 'sale', tenantId: 'a', recipientId: '4', state: 'skipped', reason: 'segment' },
    ])
  })

  it('allows repeated plans up to maxPerRecipient real sends but never twice in one batch', async () => {
    const planner = make()
    const campaign = { id: 'drip', tenantId: 'a', maxPerRecipient: 2 }

    const [first, second] = await planner.plan(campaign, [recipient(), recipient()])
    expect([first!.state, second!.state]).toEqual(['queued', 'skipped'])
    await planner.markSent(first!.deliveryId!)

    const [third] = await planner.plan(campaign, [recipient()])
    expect(third).toMatchObject({ state: 'queued' })
    await planner.markSent(third!.deliveryId!)

    expect((await planner.plan(campaign, [recipient()]))[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })
  })

  it('deduplicates per campaign, not across campaigns', async () => {
    const planner = make()
    await planner.plan({ id: 'first', tenantId: 'a' }, [recipient()])

    expect((await planner.plan({ id: 'second', tenantId: 'a' }, [recipient()]))[0]).toMatchObject({ state: 'queued' })
  })

  it('counts only real sends against maxPerRecipient, not queued or failed attempts', async () => {
    const planner = make()
    const campaign = { id: 'sale', tenantId: 'a' }

    const [queued] = await planner.plan(campaign, [recipient()])
    // While the delivery is in flight it reserves the slot, so a re-plan cannot double-send.
    expect((await planner.plan(campaign, [recipient()]))[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })

    expect(await planner.markFailed(queued!.deliveryId!, 'timeout')).toMatchObject({
      state: 'failed',
      recipientId: '1',
      error: 'timeout',
    })
    // The failed attempt released the slot: the recipient can be planned again.
    const [retry] = await planner.plan(campaign, [recipient()])
    expect(retry).toMatchObject({ state: 'queued' })
    expect(retry!.deliveryId).not.toBe(queued!.deliveryId)

    expect(await planner.markSent(retry!.deliveryId!)).toMatchObject({ state: 'sent', recipientId: '1' })
    expect(await planner.sentCount('a', 'sale', '1')).toBe(1)
    expect((await planner.plan(campaign, [recipient()]))[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })
  })

  it('rejects settling unknown or already settled deliveries', async () => {
    const planner = make()
    const [queued] = await planner.plan({ id: 'sale', tenantId: 'a' }, [recipient()])

    await planner.markSent(queued!.deliveryId!)
    await expect(planner.markSent(queued!.deliveryId!)).rejects.toThrow(/unknown or already settled/)
    await expect(planner.markFailed(queued!.deliveryId!)).rejects.toBeInstanceOf(UnknownDeliveryError)
    await expect(planner.markSent('nope')).rejects.toThrow(/unknown or already settled/)
    expect(await planner.sentCount('a', 'sale', '1')).toBe(1)
  })

  it('skips everyone with reason limit when maxPerRecipient is 0', async () => {
    const planner = make()
    const result = await planner.plan({ id: 'paused', tenantId: 'a', maxPerRecipient: 0 }, [
      recipient({ id: '1' }),
      recipient({ id: '2', optedIn: false }),
    ])

    expect(result.map((x) => [x.state, x.reason])).toEqual([
      ['skipped', 'limit'],
      ['skipped', 'opt_out'],
    ])
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects maxPerRecipient %s', async (max) => {
    const planner = make()
    await expect(planner.plan({ id: 'x', tenantId: 'a', maxPerRecipient: max }, [recipient()])).rejects.toThrow(RangeError)
  })

  it('keeps sent counts per tenant', async () => {
    const planner = make()
    const [a] = await planner.plan({ id: 'sale', tenantId: 'a' }, [recipient()])
    await planner.markSent(a!.deliveryId!)

    expect((await planner.plan({ id: 'sale', tenantId: 'b' }, [recipient({ tenantId: 'b' })]))[0]).toMatchObject({
      state: 'queued',
      tenantId: 'b',
    })
    expect(await planner.sentCount('b', 'sale', '1')).toBe(0)
  })

  it('rejects an invalid reservation TTL', () => {
    expect(() => new CampaignPlanner(new MemoryCampaignStore(), { reservationTtl: 'nope' })).toThrow()
    expect(() => new CampaignPlanner(new MemoryCampaignStore(), { reservationTtl: 0 })).toThrow(RangeError)
  })
})

class FlakyProvider extends MockProvider {
  override async send(chatId: string, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    if (chatId === 'down@s.whatsapp.net') throw new RecipientUnreachableError('provider down')
    return super.send(chatId, content, options)
  }
}

describe('sendCampaign', () => {
  it('settles sent, failed and duplicate-chat deliveries from the broadcast result', async () => {
    const provider = new FlakyProvider()
    const bot = new Bot({ provider })
    await bot.start()
    try {
      const planner = new CampaignPlanner()
      const recipients = [
        recipient({ id: 'ok', chatId: 'ok@s.whatsapp.net' }),
        recipient({ id: 'bad', chatId: 'down@s.whatsapp.net' }),
        recipient({ id: 'dup', chatId: 'ok@s.whatsapp.net' }),
      ]
      const run = await sendCampaign(bot, planner, { id: 'sale', tenantId: 'a' }, recipients, 'promo')

      expect(run.broadcast.total).toBe(2)
      expect(run.broadcast.sent).toBe(1)
      expect(run.broadcast.failed).toBe(1)
      expect(run.settleErrors).toEqual([])
      expect(run.deliveries.map((d) => [d.recipientId, d.state])).toEqual([
        ['ok', 'sent'],
        ['bad', 'failed'],
        ['dup', 'failed'],
      ])
      expect(run.deliveries[1]!.error).toMatch(/down/)
      expect(run.deliveries[2]!.error).toBe('duplicate chatId')
      expect(await planner.sentCount('a', 'sale', 'ok')).toBe(1)
      expect(await planner.sentCount('a', 'sale', 'bad')).toBe(0)
      // The sent recipient keeps its slot; the two failed ones released theirs and can be planned again.
      const replanned = await planner.plan({ id: 'sale', tenantId: 'a' }, recipients)
      expect(replanned.map((delivery) => [delivery.recipientId, delivery.state])).toEqual([
        ['ok', 'skipped'],
        ['bad', 'queued'],
        ['dup', 'queued'],
      ])
      expect(replanned[0]!.reason).toBe('duplicate')
    } finally {
      await bot.stop()
    }
  })

  it('releases the slots left pending by an aborted broadcast', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    try {
      const planner = new CampaignPlanner()
      const controller = new AbortController()
      controller.abort()
      const run = await sendCampaign(
        bot, planner, { id: 'sale', tenantId: 'a' },
        [recipient({ chatId: 'a@s.whatsapp.net' })],
        'promo',
        { signal: controller.signal },
      )
      expect(run.broadcast.cancelled).toBe(true)
      expect(run.deliveries[0]).toMatchObject({ state: 'failed', error: 'cancelled' })
      expect((await planner.plan({ id: 'sale', tenantId: 'a' }, [recipient({ chatId: 'a@s.whatsapp.net' })]))[0]).toMatchObject({ state: 'queued' })
    } finally {
      await bot.stop()
    }
  })
})
