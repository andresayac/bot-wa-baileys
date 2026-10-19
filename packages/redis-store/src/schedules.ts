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
 * Usually obtained from {@link RedisStore.schedules}, which shares the store's client,
 * prefix and key layout; the client's lifecycle stays with whoever opened it.
 *
 * Cluster key layout: `{prefix}:{sc:<b>}:r:<id>` plus the bucket index
 * `{prefix}:{sc:<b>}:idx` in the same hash slot, written in the same script as the
 * record; `list()` reads the indexes instead of scanning.
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
import type { RedisLikeClient } from './RedisStore.js'
import { casJson, type CasIndex } from './cas.js'
import { escapeGlob } from './glob.js'
import { matchKeys } from './keys.js'
import { scheduleKeys, type RedisKeyLayout, type ScheduleKeys } from './layout.js'
import { asRedisLike, resolveLayout, type AnyRedisClient } from './client.js'

export interface RedisScheduleStoreOptions {
  /** A connected node-redis client (or cluster client) or any {@link RedisLikeClient}; the caller owns its lifecycle. */
  client: AnyRedisClient
  /** Key prefix (default `'botwa'`): records live at `{prefix}:sched:{id}` (legacy layout). */
  prefix?: string
  /** Key layout; default `'cluster'` for a cluster client, else `'legacy'` (see `RedisStoreOptions.layout`). */
  layout?: RedisKeyLayout
}

export class RedisScheduleStore implements ScheduleStore {
  private readonly client: RedisLikeClient
  private readonly ns: string
  private readonly keys: ScheduleKeys
  private readonly cluster: boolean

  constructor(opts: RedisScheduleStoreOptions) {
    this.client = asRedisLike(opts.client)
    const prefix = opts.prefix ?? 'botwa'
    const layout = resolveLayout('RedisScheduleStore', { layout: opts.layout, client: opts.client })
    this.ns = `${prefix}:sched:`
    this.keys = scheduleKeys(prefix, layout)
    this.cluster = layout === 'cluster'
  }

  private key(id: string): string {
    return this.keys.record(id)
  }

  /** Cluster layout: the bucket index the record must be listed in. */
  private index(id: string): CasIndex | undefined {
    const key = this.keys.index(id)
    return key === undefined ? undefined : { key, member: id }
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
    }, this.index(rec.id))
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
    }, this.index(id))
  }

  renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    return casJson<StoredSchedule, boolean>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current || current.fencingToken !== fencingToken || current.leaseOwner === undefined) return { result: false }
      return { next: { ...current, leaseUntil }, result: true }
    }, this.index(id))
  }

  complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    return casJson<StoredSchedule, boolean>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current || current.fencingToken !== fencingToken || current.leaseOwner === undefined) return { result: false }
      return { next: applyScheduleComplete(current, patch, now), result: true }
    }, this.index(id))
  }

  /** Replaces the record with a small marker that keeps its fencing token (a high-water mark). */
  async delete(id: string): Promise<void> {
    await casJson<StoredSchedule, void>(this.client, this.key(id), (stored) => {
      const current = live(stored)
      if (!current) return { result: undefined }
      return { next: { id: current.id, deleted: true, fencingToken: current.fencingToken }, result: undefined }
    }, this.index(id))
  }

  async list(): Promise<ScheduleRecord[]> {
    const keys = this.cluster ? await this.indexedKeys() : await matchKeys(this.client, `${escapeGlob(this.ns)}*`)
    const raws = await Promise.all(keys.map((k) => this.client.get(k)))
    return raws
      .filter((r) => r != null)
      .map((r) => live(JSON.parse(String(r)) as StoredSchedule))
      .filter((r): r is ScheduleRecord => r !== null)
  }

  /** Cluster layout: record keys of every id in the bucket indexes. */
  private async indexedKeys(): Promise<string[]> {
    const buckets = await Promise.all(this.keys.all().map((idx) => this.client.zRange(idx, 0, -1)))
    return buckets.flat().map((id) => this.keys.record(String(id)))
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
