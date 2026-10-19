/**
 * RedisScheduleStore — the durable scheduler's {@link ScheduleStore} on Redis.
 *
 * One JSON record per task at `{prefix}:sched:{id}`. Every mutation is an optimistic
 * compare-and-set on that key (the same server-side CAS script RedisStore uses for
 * upserts), so a claim is atomic across replicas: of N concurrent claimers exactly
 * one writes the bumped fencing token, the rest re-read and see the live lease.
 * Lease deadlines compare the `now` the scheduler passes (the replica's clock): keep
 * replica clocks in sync (NTP) and `leaseMs` well above the expected skew.
 *
 * Usually obtained from {@link RedisStore.schedules}, which shares the store's client
 * and prefix; the client's lifecycle stays with whoever opened it.
 *
 * @example
 * ```ts
 * const store = new RedisStore({ url: process.env.REDIS_URL })
 * const bot = new Bot({ provider, store, scheduler: { store: store.schedules(), lease: store.leases() } })
 * bot.every('15m', { id: 'sync-crm', missed: 'run-once' }, async (run) => { ... })
 * ```
 */
import {
  applyScheduleComplete,
  isScheduleClaimable,
  type ClaimResult,
  type CompletePatch,
  type ScheduleRecord,
  type ScheduleStore,
} from '@bot-wa/core'
import type { NativeRedisClient, RedisLikeClient } from './RedisStore.js'
import { casJson } from './cas.js'
import { escapeGlob } from './glob.js'
import { matchKeys } from './keys.js'

export interface RedisScheduleStoreOptions {
  /** A connected node-redis client or any {@link RedisLikeClient}; the caller owns its lifecycle. */
  client: RedisLikeClient | NativeRedisClient
  /** Key prefix (default `'botwa'`): records live at `{prefix}:sched:{id}`. */
  prefix?: string
}

export class RedisScheduleStore implements ScheduleStore {
  private readonly client: RedisLikeClient
  private readonly ns: string

  constructor(opts: RedisScheduleStoreOptions) {
    this.client = opts.client as RedisLikeClient
    this.ns = `${opts.prefix ?? 'botwa'}:sched:`
  }

  private key(id: string): string {
    return this.ns + id
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const raw = await this.client.get(this.key(id))
    return raw == null ? null : live(JSON.parse(String(raw)) as StoredSchedule)
  }

  register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord> {
    return casJson<StoredSchedule, ScheduleRecord>(this.client, this.key(rec.id), (stored) => {
      const current = live(stored)
      if (!current) {
        // A deleted id starts from its last fencing token (tokens never go backwards).
        const fencingToken = stored?.fencingToken ?? 0
        const created: ScheduleRecord = { id: rec.id, kind: rec.kind, spec: rec.spec, nextRunAt: rec.nextRunAt, fencingToken, updatedAt: now }
        return { next: created, result: created }
      }
      if (current.kind === rec.kind && current.spec === rec.spec) return { result: current }
      const respec: ScheduleRecord = { ...current, kind: rec.kind, spec: rec.spec, nextRunAt: rec.nextRunAt, updatedAt: now }
      return { next: respec, result: respec }
    })
  }

  claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null> {
    return casJson<StoredSchedule, ClaimResult | null>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current || !isScheduleClaimable(current, now)) return { result: null }
      const claimed: ScheduleRecord = {
        ...current,
        fencingToken: current.fencingToken + 1,
        leaseOwner: owner,
        leaseUntil: now + leaseMs,
        updatedAt: now,
      }
      return { next: claimed, result: { record: claimed, fencingToken: claimed.fencingToken } }
    })
  }

  renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    return casJson<StoredSchedule, boolean>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current || current.fencingToken !== fencingToken || current.leaseOwner === undefined) return { result: false }
      return { next: { ...current, leaseUntil }, result: true }
    })
  }

  complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    return casJson<StoredSchedule, boolean>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current || current.fencingToken !== fencingToken || current.leaseOwner === undefined) return { result: false }
      return { next: applyScheduleComplete(current, patch, now), result: true }
    })
  }

  /** Replaces the record with a small marker that keeps its fencing token (a high-water mark). */
  async delete(id: string): Promise<void> {
    await casJson<StoredSchedule, void>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current) return { result: undefined }
      return { next: { id: current.id, deleted: true, fencingToken: current.fencingToken }, result: undefined }
    })
  }

  async list(): Promise<ScheduleRecord[]> {
    const keys = await matchKeys(this.client, `${escapeGlob(this.ns)}*`)
    const raws = await Promise.all(keys.map((k) => this.client.get(k)))
    return raws
      .filter((r) => r != null)
      .map((r) => live(JSON.parse(String(r)) as StoredSchedule))
      .filter((r): r is ScheduleRecord => r !== null)
  }
}

/** A deleted id: only its fencing token is kept, so a new registration never reuses a token. */
interface DeletedSchedule {
  id: string
  deleted: true
  fencingToken: number
}

type StoredSchedule = ScheduleRecord | DeletedSchedule

function live(stored: StoredSchedule | null): ScheduleRecord | null {
  return stored === null || 'deleted' in stored ? null : stored
}
