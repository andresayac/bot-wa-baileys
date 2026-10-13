/**
 * @bot-wa/campaigns — in-memory prototype of a consent-aware campaign planner.
 *
 * - {@link CampaignPlanner} — turns a campaign plus a recipient list into
 *   `queued` deliveries and explainable skips (`opt_out`, `segment`,
 *   `duplicate`), deduplicating per tenant, campaign and recipient.
 *
 * The planner only decides who should receive a campaign; a durable worker
 * must consume the `queued` deliveries and record the real send outcome.
 *
 * Private prototype: state lives in RAM and is not published to npm.
 *
 * @example
 * ```ts
 * const planner = new CampaignPlanner()
 * const deliveries = planner.plan(
 *   { id: 'sale', tenantId: 'acme', requiredTags: ['vip'] },
 *   [{ id: 'person-1', tenantId: 'acme', channel: 'whatsapp', optedIn: true, tags: ['vip'] }],
 * )
 * ```
 */

/** A potential recipient of a campaign. */
export interface CampaignRecipient {
  id: string
  tenantId: string
  channel: string
  /** Marketing opt-in; recipients without it are skipped with `opt_out`. */
  optedIn: boolean
  tags?: readonly string[]
}

/** Campaign definition used for planning. */
export interface Campaign {
  id: string
  tenantId: string
  /** Recipients must carry all of these tags, otherwise they are skipped with `segment`. */
  requiredTags?: readonly string[]
  /** Maximum deliveries per recipient across all `plan()` calls. Default `1`. */
  maxPerRecipient?: number
}

/** Planning decision for one recipient. */
export interface Delivery {
  campaignId: string
  recipientId: string
  state: 'queued' | 'sent' | 'skipped'
  /** Why the recipient was skipped; only present when `state` is `'skipped'`. */
  reason?: 'opt_out' | 'segment' | 'duplicate'
}

/** Reasons a recipient can be skipped. */
type SkipReason = NonNullable<Delivery['reason']>

/**
 * Plans campaign deliveries. The planner remembers how many deliveries it has
 * queued per tenant/campaign/recipient, so repeated `plan()` calls on the
 * same instance never exceed `maxPerRecipient`.
 */
export class CampaignPlanner {
  private readonly delivered = new Map<string, number>()

  /**
   * Return one {@link Delivery} per input recipient, in input order. Checks
   * run in this order: tenant mismatch (`segment`), missing opt-in
   * (`opt_out`), missing required tags (`segment`), then a repeated id in
   * this batch or the per-recipient cap reached (`duplicate`).
   */
  plan(campaign: Campaign, recipients: readonly CampaignRecipient[]): Delivery[] {
    const seen = new Set<string>()
    const cap = campaign.maxPerRecipient ?? 1

    return recipients.map((recipient) => {
      const key = `${campaign.tenantId}\u0000${campaign.id}\u0000${recipient.id}`

      if (recipient.tenantId !== campaign.tenantId) return skipped(campaign, recipient, 'segment')
      if (!recipient.optedIn) return skipped(campaign, recipient, 'opt_out')
      if (campaign.requiredTags?.some((tag) => !recipient.tags?.includes(tag))) {
        return skipped(campaign, recipient, 'segment')
      }
      if (seen.has(recipient.id) || (this.delivered.get(key) ?? 0) >= cap) {
        return skipped(campaign, recipient, 'duplicate')
      }

      seen.add(recipient.id)
      this.delivered.set(key, (this.delivered.get(key) ?? 0) + 1)
      return { campaignId: campaign.id, recipientId: recipient.id, state: 'queued' }
    })
  }
}

function skipped(campaign: Campaign, recipient: CampaignRecipient, reason: SkipReason): Delivery {
  return { campaignId: campaign.id, recipientId: recipient.id, state: 'skipped', reason }
}
