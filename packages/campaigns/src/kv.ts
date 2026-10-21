/**
 * KvCampaignStore — {@link CampaignStore} persisted through any `DurableKv` of
 * `@botmesh/core` (SQLite, PostgreSQL, Redis, file or memory) via `@botmesh/tenant-kv`.
 *
 * One table per tenant and campaign, `product/campaigns/state/<tenant>/<campaign>`:
 * id = recipient id and the document holds `sent`, the live reservations and the recent
 * deliveries. Reservation and settlement are compare-and-set loops over that single
 * document, so the operation is atomic in the backend, even between processes.
 */

import type { DurableKv } from '@botmesh/core'
import { TenantDocs, assertTenantId } from '@botmesh/tenant-kv'
import {
  applyReserve,
  applySettle,
  assertReserveInput,
  emptyState,
  parseDeliveryId,
  type RecipientState,
  type TrackedDelivery,
} from './memory.js'
import type { CampaignStore } from './store.js'
import { UnknownDeliveryError, type Delivery, type ReserveInput, type ReservationOutcome, type SettleOutcome } from './types.js'

export interface KvCampaignStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
  /** Compare-and-set retries before reporting contention (default 32). */
  attempts?: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const STATES = new Set(['queued', 'sent', 'failed'])

function parseTracked(value: unknown): TrackedDelivery {
  if (!isRecord(value) || !isString(value.state) || !STATES.has(value.state) || typeof value.at !== 'number' || !Number.isFinite(value.at)) {
    throw new TypeError('bad delivery record')
  }
  if (value.error !== undefined && !isString(value.error)) throw new TypeError('bad delivery error')
  return {
    state: value.state as TrackedDelivery['state'],
    at: value.at,
    ...(value.error !== undefined ? { error: value.error } : {}),
  }
}

function parseState(value: unknown): RecipientState {
  if (!isRecord(value)) throw new TypeError('campaign state is not an object')
  const { tenantId, campaignId, recipientId, sent, inflight, deliveries } = value
  if (!isString(tenantId) || !isString(campaignId) || !isString(recipientId)) throw new TypeError('bad campaign state ids')
  if (!Number.isSafeInteger(sent) || (sent as number) < 0) throw new TypeError('bad campaign sent counter')
  if (!isRecord(inflight) || !Object.values(inflight).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError('bad campaign reservations')
  }
  if (!isRecord(deliveries)) throw new TypeError('bad campaign deliveries')
  const parsed: Record<string, TrackedDelivery> = {}
  for (const [id, record] of Object.entries(deliveries)) parsed[id] = parseTracked(record)
  return {
    tenantId,
    campaignId,
    recipientId,
    sent: sent as number,
    inflight: { ...(inflight as Record<string, number>) },
    deliveries: parsed,
  }
}

const backoff = (attempt: number): Promise<void> => {
  if (attempt === 0) return Promise.resolve()
  const ms = Math.random() * Math.min(64, 2 ** attempt)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class KvCampaignStore implements CampaignStore {
  private readonly states: TenantDocs<RecipientState>
  private readonly clock: () => number
  private readonly attempts: number

  constructor(kv: DurableKv, options: KvCampaignStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.attempts = options.attempts ?? 32
    if (!Number.isInteger(this.attempts) || this.attempts < 1) throw new RangeError('attempts must be a positive integer')
    this.states = new TenantDocs<RecipientState>(kv, {
      family: ['campaigns', 'state'],
      parse: parseState,
      order: (state) => -(state.sent + Object.keys(state.inflight).length),
    })
  }

  async reserve(input: ReserveInput): Promise<ReservationOutcome> {
    assertReserveInput(input)
    const table = this.states.in(input.tenantId, input.campaignId)
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await backoff(attempt)
      const current = await table.get(input.recipientId)
      const state = current?.doc ?? emptyState(input.tenantId, input.campaignId, input.recipientId)
      const outcome = applyReserve(state, input)
      if (outcome !== 'reserved') return outcome ?? 'duplicate'
      const written = current ? await table.replace(input.recipientId, current.version, state) : await table.insert(input.recipientId, state)
      if (written) return 'reserved'
    }
    throw new Error(`too much contention reserving ${JSON.stringify(input.recipientId)} after ${this.attempts} attempts`)
  }

  async settle(deliveryId: string, outcome: SettleOutcome, options: { now?: number } = {}): Promise<Delivery> {
    const ids = parseDeliveryId(deliveryId)
    if (!ids) throw new UnknownDeliveryError()
    assertTenantId(ids.tenantId)
    const table = this.states.in(ids.tenantId, ids.campaignId)
    const now = options.now ?? this.clock()
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await backoff(attempt)
      const current = await table.get(ids.recipientId)
      if (!current) throw new UnknownDeliveryError()
      const delivery = applySettle(current.doc, deliveryId, outcome, now)
      const written = await table.replace(ids.recipientId, current.version, current.doc)
      if (written) return delivery
    }
    throw new Error(`too much contention settling ${JSON.stringify(deliveryId)} after ${this.attempts} attempts`)
  }

  async sentCount(tenantId: string, campaignId: string, recipientId: string): Promise<number> {
    assertTenantId(tenantId)
    assertTenantId(campaignId, 'campaignId')
    assertTenantId(recipientId, 'recipientId')
    return (await this.states.in(tenantId, campaignId).get(recipientId))?.doc.sent ?? 0
  }
}
