import { describe, expect, it } from 'vitest'

import { CampaignPlanner, type CampaignRecipient } from '../src/index.js'

function recipient(overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return { id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'], ...overrides }
}

describe('CampaignPlanner', () => {
  it('honors consent, segments and deduplicates per tenant', () => {
    const planner = new CampaignPlanner()
    const campaign = { id: 'sale', tenantId: 'a', requiredTags: ['vip'] }

    const result = planner.plan(campaign, [
      { id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'] },
      { id: '2', tenantId: 'a', channel: 'wa', optedIn: false },
      { id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'] },
      { id: '3', tenantId: 'b', channel: 'wa', optedIn: true, tags: ['vip'] },
    ])

    expect(result.map((x) => x.state)).toEqual(['queued', 'skipped', 'skipped', 'skipped'])
    expect(
      planner.plan(campaign, [{ id: '1', tenantId: 'a', channel: 'wa', optedIn: true, tags: ['vip'] }])[0],
    ).toMatchObject({ reason: 'duplicate' })
  })

  it('explains every skip with a reason', () => {
    const planner = new CampaignPlanner()
    const campaign = { id: 'sale', tenantId: 'a', requiredTags: ['vip'] }

    const result = planner.plan(campaign, [
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

  it('allows repeated plans up to maxPerRecipient real sends but never twice in one batch', () => {
    const planner = new CampaignPlanner()
    const campaign = { id: 'drip', tenantId: 'a', maxPerRecipient: 2 }

    const [first, second] = planner.plan(campaign, [recipient(), recipient()])
    expect([first!.state, second!.state]).toEqual(['queued', 'skipped'])
    planner.markSent(first!.deliveryId!)

    const [third] = planner.plan(campaign, [recipient()])
    expect(third).toMatchObject({ state: 'queued' })
    planner.markSent(third!.deliveryId!)

    expect(planner.plan(campaign, [recipient()])[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })
  })

  it('deduplicates per campaign, not across campaigns', () => {
    const planner = new CampaignPlanner()
    planner.plan({ id: 'first', tenantId: 'a' }, [recipient()])

    expect(planner.plan({ id: 'second', tenantId: 'a' }, [recipient()])[0]).toMatchObject({ state: 'queued' })
  })

  it('counts only real sends against maxPerRecipient, not queued or failed attempts', () => {
    const planner = new CampaignPlanner()
    const campaign = { id: 'sale', tenantId: 'a' }

    const [queued] = planner.plan(campaign, [recipient()])
    // While the delivery is in flight it reserves the slot, so a re-plan cannot double-send.
    expect(planner.plan(campaign, [recipient()])[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })

    expect(planner.markFailed(queued!.deliveryId!, 'timeout')).toMatchObject({
      state: 'failed',
      recipientId: '1',
      error: 'timeout',
    })
    // The failed attempt released the slot: the recipient can be planned again.
    const [retry] = planner.plan(campaign, [recipient()])
    expect(retry).toMatchObject({ state: 'queued' })
    expect(retry!.deliveryId).not.toBe(queued!.deliveryId)

    expect(planner.markSent(retry!.deliveryId!)).toMatchObject({ state: 'sent', recipientId: '1' })
    expect(planner.sentCount('a', 'sale', '1')).toBe(1)
    expect(planner.plan(campaign, [recipient()])[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })
  })

  it('rejects settling unknown or already settled deliveries', () => {
    const planner = new CampaignPlanner()
    const [queued] = planner.plan({ id: 'sale', tenantId: 'a' }, [recipient()])

    planner.markSent(queued!.deliveryId!)
    expect(() => planner.markSent(queued!.deliveryId!)).toThrow(/unknown or already settled/)
    expect(() => planner.markFailed(queued!.deliveryId!)).toThrow(/unknown or already settled/)
    expect(() => planner.markSent('nope')).toThrow(/unknown or already settled/)
    expect(planner.sentCount('a', 'sale', '1')).toBe(1)
  })

  it('skips everyone with reason limit when maxPerRecipient is 0', () => {
    const planner = new CampaignPlanner()
    const result = planner.plan({ id: 'paused', tenantId: 'a', maxPerRecipient: 0 }, [
      recipient({ id: '1' }),
      recipient({ id: '2', optedIn: false }),
    ])

    expect(result.map((x) => [x.state, x.reason])).toEqual([
      ['skipped', 'limit'],
      ['skipped', 'opt_out'],
    ])
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects maxPerRecipient %s', (max) => {
    const planner = new CampaignPlanner()
    expect(() => planner.plan({ id: 'x', tenantId: 'a', maxPerRecipient: max }, [recipient()])).toThrow(RangeError)
  })

  it('keeps sent counts per tenant', () => {
    const planner = new CampaignPlanner()
    const [a] = planner.plan({ id: 'sale', tenantId: 'a' }, [recipient()])
    planner.markSent(a!.deliveryId!)

    expect(planner.plan({ id: 'sale', tenantId: 'b' }, [recipient({ tenantId: 'b' })])[0]).toMatchObject({
      state: 'queued',
      tenantId: 'b',
    })
    expect(planner.sentCount('b', 'sale', '1')).toBe(0)
  })
})
