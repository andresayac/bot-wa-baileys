/**
 * @bot-wa/campaigns — consent-aware campaign planner with durable reservations.
 *
 * - {@link CampaignPlanner} — turns a campaign plus a recipient list into `queued`
 *   deliveries and explainable skips (`opt_out`, `segment`, `duplicate`, `limit`),
 *   deduplicating per tenant, campaign and recipient. Only confirmed sends count
 *   towards `maxPerRecipient`; a queued delivery reserves its slot until it is settled
 *   or its reservation TTL expires.
 * - {@link MemoryCampaignStore} — the in-RAM reference store (default).
 * - {@link KvCampaignStore} — persisted through any `DurableKv` of `@bot-wa/core`
 *   (SQLite, PostgreSQL, Redis, file) via `@bot-wa/tenant-kv`.
 * - {@link sendCampaign} — plans and sends with `bot.broadcast()`, settling each
 *   delivery from the real result.
 *
 * Private package: not published to npm.
 *
 * @example
 * ```ts
 * const planner = new CampaignPlanner(new KvCampaignStore(new PostgresDurableKv({ pool })))
 * const run = await sendCampaign(
 *   bot, planner,
 *   { id: 'sale', tenantId: 'acme', requiredTags: ['vip'] },
 *   [{ id: 'person-1', tenantId: 'acme', channel: 'whatsapp', optedIn: true, tags: ['vip'], chatId: '57300@s.whatsapp.net' }],
 *   'Nueva promo',
 * )
 * // run.deliveries[0].state === 'sent' (or 'failed' with the real error)
 * ```
 */

export { CampaignPlanner } from './planner.js'
export type { CampaignPlannerOptions } from './planner.js'
export { MemoryCampaignStore, makeDeliveryId, parseDeliveryId } from './memory.js'
export type { MemoryCampaignStoreOptions, RecipientState, TrackedDelivery } from './memory.js'
export { KvCampaignStore } from './kv.js'
export type { KvCampaignStoreOptions } from './kv.js'
export type { CampaignStore } from './store.js'
export { sendCampaign } from './send.js'
export type { CampaignRun, CampaignSettleError } from './send.js'
export { UnknownDeliveryError } from './types.js'
export type {
  Campaign,
  CampaignRecipient,
  Delivery,
  ReservationOutcome,
  ReserveInput,
  SettleOutcome,
} from './types.js'
