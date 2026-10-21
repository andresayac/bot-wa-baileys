/**
 * CampaignPlanner — consent-aware planning on top of a {@link CampaignStore}. Pure
 * consent/segment rules decide the skips; the store atomically reserves one send slot
 * per eligible recipient, so repeated `plan()` calls (even from other processes) never
 * exceed `maxPerRecipient` and never double-queue a recipient. A queued delivery holds
 * its slot until a worker settles it with {@link CampaignPlanner.markSent} or
 * {@link CampaignPlanner.markFailed}, or until its reservation TTL expires.
 */

import { parseDuration } from '@botmesh/core'
import { DEFAULT_RESERVATION_TTL_MS, MemoryCampaignStore, makeDeliveryId } from './memory.js'
import type { CampaignStore } from './store.js'
import type { Campaign, CampaignRecipient, Delivery } from './types.js'

export interface CampaignPlannerOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
  /** Reservation TTL: ms or a duration string (`'15m'`). Default 15 minutes. */
  reservationTtl?: number | string
}

function reservationMs(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_RESERVATION_TTL_MS
  const ms = typeof value === 'string' ? parseDuration(value) : value
  if (!(Number.isFinite(ms) && ms > 0)) throw new RangeError('reservationTtl must be a positive duration')
  return ms
}

export class CampaignPlanner {
  private readonly clock: () => number
  private readonly ttlMs: number

  constructor(readonly store: CampaignStore = new MemoryCampaignStore(), options: CampaignPlannerOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.ttlMs = reservationMs(options.reservationTtl)
  }

  /**
   * Return one {@link Delivery} per input recipient, in input order. Checks run in this
   * order: tenant mismatch (`segment`), missing opt-in (`opt_out`), missing required tags
   * (`segment`), `maxPerRecipient` of `0` (`limit`), then a repeated id in this batch or
   * the per-recipient cap used up by sent and in-flight deliveries (`duplicate`).
   *
   * @throws RangeError when `maxPerRecipient` is not a non-negative integer.
   */
  async plan(campaign: Campaign, recipients: readonly CampaignRecipient[]): Promise<Delivery[]> {
    const cap = campaign.maxPerRecipient ?? 1
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new RangeError('maxPerRecipient must be a non-negative integer')
    }
    const seen = new Set<string>()
    const now = this.clock()
    const deliveries: Delivery[] = []

    for (const recipient of recipients) {
      if (recipient.tenantId !== campaign.tenantId) {
        deliveries.push(skipped(campaign, recipient, 'segment'))
        continue
      }
      if (!recipient.optedIn) {
        deliveries.push(skipped(campaign, recipient, 'opt_out'))
        continue
      }
      if (campaign.requiredTags?.some((tag) => !recipient.tags?.includes(tag))) {
        deliveries.push(skipped(campaign, recipient, 'segment'))
        continue
      }
      if (cap === 0) {
        deliveries.push(skipped(campaign, recipient, 'limit'))
        continue
      }
      if (seen.has(recipient.id)) {
        deliveries.push(skipped(campaign, recipient, 'duplicate'))
        continue
      }
      seen.add(recipient.id)

      const deliveryId = makeDeliveryId(campaign.tenantId, campaign.id, recipient.id)
      const outcome = await this.store.reserve({
        tenantId: campaign.tenantId,
        campaignId: campaign.id,
        recipientId: recipient.id,
        deliveryId,
        maxPerRecipient: cap,
        now,
        ttlMs: this.ttlMs,
      })
      deliveries.push(outcome === 'reserved'
        ? { campaignId: campaign.id, tenantId: campaign.tenantId, recipientId: recipient.id, state: 'queued', deliveryId }
        : skipped(campaign, recipient, outcome === 'limit' ? 'limit' : 'duplicate'))
    }
    return deliveries
  }

  /**
   * Record that a queued delivery was actually sent; it now counts towards
   * `maxPerRecipient`.
   * @throws {UnknownDeliveryError} when the id is unknown or already settled.
   */
  markSent(deliveryId: string): Promise<Delivery> {
    return this.store.settle(deliveryId, { state: 'sent' }, { now: this.clock() })
  }

  /**
   * Record that a queued delivery failed; its slot is released, so a later `plan()` may
   * queue the recipient again.
   * @throws {UnknownDeliveryError} when the id is unknown or already settled.
   */
  markFailed(deliveryId: string, error?: string): Promise<Delivery> {
    return this.store.settle(deliveryId, { state: 'failed', ...(error !== undefined ? { error } : {}) }, { now: this.clock() })
  }

  /** Confirmed sends for one tenant/campaign/recipient. */
  sentCount(tenantId: string, campaignId: string, recipientId: string): Promise<number> {
    return this.store.sentCount(tenantId, campaignId, recipientId)
  }
}

function skipped(campaign: Campaign, recipient: CampaignRecipient, reason: NonNullable<Delivery['reason']>): Delivery {
  return { campaignId: campaign.id, tenantId: campaign.tenantId, recipientId: recipient.id, state: 'skipped', reason }
}
