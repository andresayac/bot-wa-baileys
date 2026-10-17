/**
 * @bot-wa/campaigns — in-memory prototype of a consent-aware campaign planner.
 *
 * - {@link CampaignPlanner} — turns a campaign plus a recipient list into
 *   `queued` deliveries and explainable skips (`opt_out`, `segment`,
 *   `duplicate`, `limit`), deduplicating per tenant, campaign and recipient.
 *
 * Planning is separate from sending: a worker consumes each `queued`
 * delivery and reports the real outcome with
 * {@link CampaignPlanner.markSent} or {@link CampaignPlanner.markFailed}.
 * Only confirmed sends count towards `maxPerRecipient`; a queued delivery
 * reserves its slot until it is settled, and a failed one releases it.
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
 * for (const delivery of deliveries) {
 *   if (delivery.state !== 'queued') continue
 *   try {
 *     await send(delivery.recipientId)
 *     planner.markSent(delivery.deliveryId!)
 *   } catch (error) {
 *     planner.markFailed(delivery.deliveryId!, String(error))
 *   }
 * }
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
  /**
   * Maximum successful sends per recipient for this tenant/campaign across all
   * `plan()` calls (a non-negative integer, default `1`). `0` pauses the
   * campaign: eligible recipients are skipped with reason `limit`.
   */
  maxPerRecipient?: number
}

/** Planning decision (and, once settled, send outcome) for one recipient. */
export interface Delivery {
  campaignId: string
  tenantId: string
  recipientId: string
  /**
   * `queued` until a worker settles it with {@link CampaignPlanner.markSent}
   * (`sent`) or {@link CampaignPlanner.markFailed} (`failed`).
   */
  state: 'queued' | 'sent' | 'failed' | 'skipped'
  /** Handle for settling the delivery; present on queued, sent and failed deliveries. */
  deliveryId?: string
  /**
   * Why the recipient was skipped; only present when `state` is `'skipped'`.
   * `duplicate`: repeated in this batch, or the cap is used by sent/in-flight
   * deliveries. `limit`: `maxPerRecipient` is `0`.
   */
  reason?: 'opt_out' | 'segment' | 'duplicate' | 'limit'
  /** Failure description passed to {@link CampaignPlanner.markFailed}. */
  error?: string
}

/** Reasons a recipient can be skipped. */
type SkipReason = NonNullable<Delivery['reason']>

interface Pending {
  key: string
  delivery: Delivery
}

/**
 * Plans campaign deliveries and tracks their outcome. Per tenant/campaign/
 * recipient it counts confirmed sends plus in-flight (queued, unsettled)
 * deliveries, so repeated `plan()` calls on the same instance never exceed
 * `maxPerRecipient` real sends and never double-queue a recipient.
 */
export class CampaignPlanner {
  private readonly sent = new Map<string, number>()
  private readonly inFlight = new Map<string, number>()
  private readonly pending = new Map<string, Pending>()

  /**
   * Return one {@link Delivery} per input recipient, in input order. Checks
   * run in this order: tenant mismatch (`segment`), missing opt-in
   * (`opt_out`), missing required tags (`segment`), `maxPerRecipient` of `0`
   * (`limit`), then a repeated id in this batch or the per-recipient cap
   * used up by sent and in-flight deliveries (`duplicate`).
   *
   * @throws RangeError when `maxPerRecipient` is not a non-negative integer.
   */
  plan(campaign: Campaign, recipients: readonly CampaignRecipient[]): Delivery[] {
    const cap = campaign.maxPerRecipient ?? 1
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new RangeError('maxPerRecipient must be a non-negative integer')
    }
    const seen = new Set<string>()

    return recipients.map((recipient) => {
      if (recipient.tenantId !== campaign.tenantId) return skipped(campaign, recipient, 'segment')
      if (!recipient.optedIn) return skipped(campaign, recipient, 'opt_out')
      if (campaign.requiredTags?.some((tag) => !recipient.tags?.includes(tag))) {
        return skipped(campaign, recipient, 'segment')
      }
      if (cap === 0) return skipped(campaign, recipient, 'limit')

      const key = recipientKey(campaign.tenantId, campaign.id, recipient.id)
      if (seen.has(recipient.id) || (this.sent.get(key) ?? 0) + (this.inFlight.get(key) ?? 0) >= cap) {
        return skipped(campaign, recipient, 'duplicate')
      }

      seen.add(recipient.id)
      const delivery: Delivery = {
        campaignId: campaign.id,
        tenantId: campaign.tenantId,
        recipientId: recipient.id,
        state: 'queued',
        deliveryId: crypto.randomUUID(),
      }
      this.pending.set(delivery.deliveryId!, { key, delivery })
      this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1)
      return { ...delivery }
    })
  }

  /**
   * Record that a queued delivery was actually sent; it now counts towards
   * `maxPerRecipient`. Throws when the id is unknown or already settled.
   */
  markSent(deliveryId: string): Delivery {
    const { key, delivery } = this.settle(deliveryId)
    this.sent.set(key, (this.sent.get(key) ?? 0) + 1)
    return { ...delivery, state: 'sent' }
  }

  /**
   * Record that a queued delivery failed; its slot is released, so a later
   * `plan()` may queue the recipient again. Throws when the id is unknown or
   * already settled.
   */
  markFailed(deliveryId: string, error?: string): Delivery {
    const { delivery } = this.settle(deliveryId)
    return error === undefined ? { ...delivery, state: 'failed' } : { ...delivery, state: 'failed', error }
  }

  /** Confirmed sends for one tenant/campaign/recipient. */
  sentCount(tenantId: string, campaignId: string, recipientId: string): number {
    return this.sent.get(recipientKey(tenantId, campaignId, recipientId)) ?? 0
  }

  private settle(deliveryId: string): Pending {
    const entry = this.pending.get(deliveryId)
    if (!entry) throw new Error('unknown or already settled delivery')
    this.pending.delete(deliveryId)
    const left = (this.inFlight.get(entry.key) ?? 1) - 1
    if (left > 0) this.inFlight.set(entry.key, left)
    else this.inFlight.delete(entry.key)
    return entry
  }
}

function skipped(campaign: Campaign, recipient: CampaignRecipient, reason: SkipReason): Delivery {
  return { campaignId: campaign.id, tenantId: campaign.tenantId, recipientId: recipient.id, state: 'skipped', reason }
}

/** NUL-separated key, so equal ids in different tenants or campaigns never collide. */
function recipientKey(tenantId: string, campaignId: string, recipientId: string): string {
  return `${tenantId}\u0000${campaignId}\u0000${recipientId}`
}
