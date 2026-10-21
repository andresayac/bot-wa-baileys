/**
 * CampaignStore — the storage contract of `@botmesh/campaigns`. `MemoryCampaignStore` is
 * the reference implementation and `KvCampaignStore` persists through any `DurableKv` of
 * `@botmesh/core`; both pass `test-utils/campaign-store-conformance.ts`.
 *
 * The per-(tenant, campaign, recipient) state document is the atomic unit: a
 * reservation, its settlement and the `sent` counter live together, so two workers can
 * never exceed `maxPerRecipient` and a settled delivery is never counted twice. A
 * reservation that is not settled before its TTL stops reserving the slot.
 */

import type { Delivery, ReserveInput, ReservationOutcome, SettleOutcome } from './types.js'

export interface CampaignStore {
  /** Reserve one send slot for a recipient, or explain why it cannot be reserved. */
  reserve(input: ReserveInput): Promise<ReservationOutcome>
  /**
   * Settle a queued delivery (from its encoded id) as `sent` (counts) or `failed`
   * (releases the slot).
   * @throws {UnknownDeliveryError} when the id is unknown or was already settled.
   */
  settle(deliveryId: string, outcome: SettleOutcome, options?: { now?: number }): Promise<Delivery>
  /** Confirmed sends for one tenant/campaign/recipient. */
  sentCount(tenantId: string, campaignId: string, recipientId: string): Promise<number>
}
