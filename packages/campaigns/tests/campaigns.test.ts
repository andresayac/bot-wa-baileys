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
      { campaignId: 'sale', recipientId: '1', state: 'queued' },
      { campaignId: 'sale', recipientId: '2', state: 'skipped', reason: 'opt_out' },
      { campaignId: 'sale', recipientId: '3', state: 'skipped', reason: 'segment' },
      { campaignId: 'sale', recipientId: '1', state: 'skipped', reason: 'duplicate' },
      { campaignId: 'sale', recipientId: '4', state: 'skipped', reason: 'segment' },
    ])
  })

  it('allows repeated plans up to maxPerRecipient but never twice in one batch', () => {
    const planner = new CampaignPlanner()
    const campaign = { id: 'drip', tenantId: 'a', maxPerRecipient: 2 }

    expect(planner.plan(campaign, [recipient(), recipient()]).map((x) => x.state)).toEqual(['queued', 'skipped'])
    expect(planner.plan(campaign, [recipient()])[0]).toMatchObject({ state: 'queued' })
    expect(planner.plan(campaign, [recipient()])[0]).toMatchObject({ state: 'skipped', reason: 'duplicate' })
  })

  it('deduplicates per campaign, not across campaigns', () => {
    const planner = new CampaignPlanner()
    planner.plan({ id: 'first', tenantId: 'a' }, [recipient()])

    expect(planner.plan({ id: 'second', tenantId: 'a' }, [recipient()])[0]).toMatchObject({ state: 'queued' })
  })
})
