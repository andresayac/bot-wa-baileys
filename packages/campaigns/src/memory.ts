/**
 * MemoryCampaignStore — the in-RAM reference implementation of {@link CampaignStore},
 * plus the id codec and state helpers both stores share. The state of one
 * (tenant, campaign, recipient) is a single record: `sent`, the live reservations and
 * the state of the recent deliveries, so a settlement is one atomic step.
 */

import { randomUUID } from 'node:crypto'
import { assertTenantId } from '@botmesh/tenant-kv'
import type { CampaignStore } from './store.js'
import { UnknownDeliveryError, type Delivery, type ReserveInput, type ReservationOutcome, type SettleOutcome } from './types.js'

export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000
/** Settled deliveries tracked per recipient (the oldest are forgotten). */
export const MAX_TRACKED_DELIVERIES = 100

export interface MemoryCampaignStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
}

/** One (tenant, campaign, recipient) state record; also the persisted document shape. */
export interface RecipientState {
  tenantId: string
  campaignId: string
  recipientId: string
  sent: number
  /** deliveryId → epoch ms after which the reservation no longer reserves its slot. */
  inflight: Record<string, number>
  /** Recent deliveries: `queued`, `sent` or `failed`. */
  deliveries: Record<string, TrackedDelivery>
}

export interface TrackedDelivery {
  state: 'queued' | 'sent' | 'failed'
  /** Epoch ms of the last state change. */
  at: number
  error?: string
}

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
const unb64 = (value: string): string => Buffer.from(value, 'base64url').toString('utf8')

/** `v1.<tenant>.<campaign>.<recipient>.<uuid>`, every id base64url-encoded (no delimiter collisions). */
export function makeDeliveryId(tenantId: string, campaignId: string, recipientId: string): string {
  return `v1.${b64(tenantId)}.${b64(campaignId)}.${b64(recipientId)}.${randomUUID()}`
}

/** Decode a delivery id; `undefined` when it was not produced by {@link makeDeliveryId}. */
export function parseDeliveryId(deliveryId: string): { tenantId: string; campaignId: string; recipientId: string } | undefined {
  if (typeof deliveryId !== 'string') return undefined
  const parts = deliveryId.split('.')
  if (parts.length !== 5 || parts[0] !== 'v1' || !parts[1] || !parts[2] || !parts[3] || !parts[4]) return undefined
  try {
    const tenantId = unb64(parts[1])
    const campaignId = unb64(parts[2])
    const recipientId = unb64(parts[3])
    if (!tenantId || !campaignId || !recipientId) return undefined
    return { tenantId, campaignId, recipientId }
  } catch {
    return undefined
  }
}

export function assertReserveInput(input: ReserveInput): void {
  assertTenantId(input.tenantId)
  assertTenantId(input.campaignId, 'campaignId')
  assertTenantId(input.recipientId, 'recipientId')
  if (typeof input.deliveryId !== 'string' || input.deliveryId === '') throw new TypeError('deliveryId must be a non-empty string')
  if (!Number.isSafeInteger(input.maxPerRecipient) || input.maxPerRecipient < 0) {
    throw new RangeError('maxPerRecipient must be a non-negative integer')
  }
  if (!Number.isFinite(input.now)) throw new RangeError('now must be a finite number')
  if (!(Number.isFinite(input.ttlMs) && input.ttlMs > 0)) throw new RangeError('ttlMs must be a positive number')
}

export function emptyState(tenantId: string, campaignId: string, recipientId: string): RecipientState {
  return { tenantId, campaignId, recipientId, sent: 0, inflight: {}, deliveries: {} }
}

/** The delivery view of a tracked record. */
export function deliveryOf(state: RecipientState, deliveryId: string): Delivery {
  const tracked = state.deliveries[deliveryId]
  return {
    tenantId: state.tenantId,
    campaignId: state.campaignId,
    recipientId: state.recipientId,
    deliveryId,
    state: tracked?.state ?? 'queued',
    ...(tracked?.error !== undefined ? { error: tracked.error } : {}),
  }
}

/**
 * Drop expired reservations (they free their slot and are marked failed) and forget the
 * oldest settled deliveries beyond {@link MAX_TRACKED_DELIVERIES}. Mutates `state`.
 */
export function pruneState(state: RecipientState, now: number): void {
  for (const [id, until] of Object.entries(state.inflight)) {
    if (until <= now) {
      delete state.inflight[id]
      state.deliveries[id] = { state: 'failed', at: now, error: 'reservation expired' }
    }
  }
  const settled = Object.entries(state.deliveries)
    .filter(([, tracked]) => tracked.state !== 'queued')
    .sort((a, b) => a[1].at - b[1].at)
  for (let i = 0; i < settled.length - MAX_TRACKED_DELIVERIES; i++) delete state.deliveries[settled[i]![0]]
}

/** Apply a reservation to `state`; `undefined` when it cannot be reserved. */
export function applyReserve(state: RecipientState, input: ReserveInput): ReservationOutcome | undefined {
  pruneState(state, input.now)
  if (input.maxPerRecipient === 0) return 'limit'
  if (state.sent + Object.keys(state.inflight).length >= input.maxPerRecipient) return 'duplicate'
  state.inflight[input.deliveryId] = input.now + input.ttlMs
  state.deliveries[input.deliveryId] = { state: 'queued', at: input.now }
  return 'reserved'
}

/** Apply a settlement to `state`; throws when the delivery is unknown or already settled. */
export function applySettle(state: RecipientState, deliveryId: string, outcome: SettleOutcome, now: number): Delivery {
  const tracked = state.deliveries[deliveryId]
  if (!tracked || tracked.state !== 'queued') throw new UnknownDeliveryError()
  delete state.inflight[deliveryId]
  if (outcome.state === 'sent') state.sent += 1
  state.deliveries[deliveryId] = {
    state: outcome.state,
    at: now,
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  }
  return deliveryOf(state, deliveryId)
}

const stateKey = (tenantId: string, campaignId: string, recipientId: string): string =>
  `${tenantId}\u0000${campaignId}\u0000${recipientId}`

export class MemoryCampaignStore implements CampaignStore {
  private readonly states = new Map<string, RecipientState>()
  private readonly clock: () => number

  constructor(options: MemoryCampaignStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
  }

  async reserve(input: ReserveInput): Promise<ReservationOutcome> {
    assertReserveInput(input)
    const key = stateKey(input.tenantId, input.campaignId, input.recipientId)
    const state = this.states.get(key) ?? emptyState(input.tenantId, input.campaignId, input.recipientId)
    const outcome = applyReserve(state, input)
    this.states.set(key, state)
    return outcome ?? 'duplicate'
  }

  async settle(deliveryId: string, outcome: SettleOutcome, options: { now?: number } = {}): Promise<Delivery> {
    const ids = parseDeliveryId(deliveryId)
    if (!ids) throw new UnknownDeliveryError()
    const state = this.states.get(stateKey(ids.tenantId, ids.campaignId, ids.recipientId))
    if (!state) throw new UnknownDeliveryError()
    return applySettle(state, deliveryId, outcome, options.now ?? this.clock())
  }

  async sentCount(tenantId: string, campaignId: string, recipientId: string): Promise<number> {
    assertTenantId(tenantId)
    assertTenantId(campaignId, 'campaignId')
    assertTenantId(recipientId, 'recipientId')
    return this.states.get(stateKey(tenantId, campaignId, recipientId))?.sent ?? 0
  }
}
