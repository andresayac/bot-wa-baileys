/**
 * MongoScheduleStore — the durable scheduler's {@link ScheduleStore} on MongoDB.
 *
 * One collection, `{prefix}schedules`, one document per durable task id (`_id`). Every
 * contract method is ONE atomic single-document command (no transactions, so a standalone
 * `mongod` works): `claimDue` is a conditional `findOneAndUpdate` with `$inc` on the token
 * (a write conflict makes the server re-evaluate the filter, so there is exactly one
 * winner), and `renew`/`complete` are `updateOne` calls fenced by the token.
 *
 * `delete()` is a soft delete: the document stays as a tombstone (`deleted: true`, lease
 * removed) so the id's fencing token is never lost, and a later `register()` revives it as
 * a fresh record that keeps the token. Every other call ignores deleted documents.
 *
 * The collection is borrowed (its client is never closed here): usually through
 * {@link MongoStore.schedules}, which uses the store's client, database and prefix.
 *
 * @example
 * ```ts
 * const store = new MongoStore({ url: process.env.MONGO_URL, dbName: 'mybot' })
 * const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
 * bot.schedule('0 9 * * *', { id: 'daily-report', timeZone: 'America/Mexico_City' }, async (run) => { … })
 * ```
 */

import type { ClaimResult, CompletePatch, ScheduleKind, ScheduleRecord, ScheduleStore } from '@botmesh/core'

/** A stored schedule document. */
export interface ScheduleDoc {
  _id: string
  kind: string
  spec: string
  nextRunAt: number | null
  lastRunAt?: number
  lastStatus?: 'ok' | 'error'
  fencingToken: number
  leaseOwner?: string
  leaseUntil?: number
  deleted: boolean
  updatedAt: number
}

/**
 * Structural subset of a driver `Collection` used by {@link MongoScheduleStore} (a native
 * `Collection` is accepted as is; tests inject an in-memory fake).
 */
export interface MongoScheduleCollectionLike {
  findOne(filter: Record<string, unknown>): Promise<ScheduleDoc | null>
  insertOne(doc: ScheduleDoc): Promise<unknown>
  /** Driver v6 default: resolves with the document itself (or `null`). */
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options: { returnDocument: 'after' }): Promise<ScheduleDoc | null>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number }>
  find(filter: Record<string, unknown>): { toArray(): Promise<ScheduleDoc[]> }
}

export interface MongoScheduleStoreOptions {
  /** The schedules collection: a native `Collection` or any {@link MongoScheduleCollectionLike}. */
  collection: MongoScheduleCollectionLike | object
}

const REGISTER_ATTEMPTS = 3
const DUPLICATE_KEY = 11000
const LEASE_UNSET = { leaseOwner: '', leaseUntil: '' }

/** Int32/Long/Double/bigint → number. */
export function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v !== null && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v)
}

const isNull = (v: unknown) => v === null || v === undefined

function fromDoc(doc: ScheduleDoc): ScheduleRecord {
  const rec: ScheduleRecord = {
    id: doc._id,
    kind: doc.kind as ScheduleKind,
    spec: doc.spec,
    nextRunAt: isNull(doc.nextRunAt) ? null : toNum(doc.nextRunAt),
    fencingToken: toNum(doc.fencingToken),
    updatedAt: toNum(doc.updatedAt),
  }
  if (!isNull(doc.lastRunAt)) rec.lastRunAt = toNum(doc.lastRunAt)
  if (doc.lastStatus === 'ok' || doc.lastStatus === 'error') rec.lastStatus = doc.lastStatus
  if (!isNull(doc.leaseOwner)) rec.leaseOwner = doc.leaseOwner
  if (!isNull(doc.leaseUntil)) rec.leaseUntil = toNum(doc.leaseUntil)
  return rec
}

export class MongoScheduleStore implements ScheduleStore {
  private readonly col: MongoScheduleCollectionLike

  constructor(opts: MongoScheduleStoreOptions) {
    const col = opts?.collection as Partial<MongoScheduleCollectionLike> | undefined
    const methods = ['findOne', 'insertOne', 'findOneAndUpdate', 'updateOne', 'find'] as const
    if (!col || methods.some((m) => typeof col[m] !== 'function')) {
      throw new TypeError(`MongoScheduleStore: \`collection\` must be a MongoDB collection (${methods.join(', ')})`)
    }
    this.col = col as MongoScheduleCollectionLike
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const doc = await this.col.findOne({ _id: id, deleted: false })
    return doc ? fromDoc(doc) : null
  }

  async register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord> {
    const { id, kind, spec, nextRunAt } = rec
    for (let attempt = 1; ; attempt++) {
      try {
        const fresh: ScheduleDoc = { _id: id, kind, spec, nextRunAt, fencingToken: 0, deleted: false, updatedAt: now }
        await this.col.insertOne({ ...fresh })
        // A brand-new document: soft delete means an id inserted here was never seen, so token 0.
        return fromDoc(fresh)
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== DUPLICATE_KEY) throw err
      }
      // Revive a tombstone: fresh state, token kept.
      const revived = await this.col.findOneAndUpdate(
        { _id: id, deleted: true },
        { $set: { kind, spec, nextRunAt, updatedAt: now, deleted: false }, $unset: { lastRunAt: '', lastStatus: '', ...LEASE_UNSET } },
        { returnDocument: 'after' },
      )
      if (revived) return fromDoc(revived)
      // A changed kind/spec: overwrite them and nextRunAt (lease and token kept).
      const respec = await this.col.findOneAndUpdate(
        { _id: id, deleted: false, $or: [{ kind: { $ne: kind } }, { spec: { $ne: spec } }] },
        { $set: { kind, spec, nextRunAt, updatedAt: now } },
        { returnDocument: 'after' },
      )
      if (respec) return fromDoc(respec)
      const stored = await this.get(id)
      if (stored) return stored
      // Deleted between the commands: register again.
      if (attempt >= REGISTER_ATTEMPTS) throw new Error(`MongoScheduleStore: register(${JSON.stringify(id)}) kept racing a delete`)
    }
  }

  async claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null> {
    const doc = await this.col.findOneAndUpdate(
      {
        _id: id,
        deleted: false,
        nextRunAt: { $ne: null, $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
      },
      { $inc: { fencingToken: 1 }, $set: { leaseOwner: owner, leaseUntil: now + leaseMs, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!doc) return null
    const record = fromDoc(doc)
    return { record, fencingToken: record.fencingToken }
  }

  async renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    // matchedCount, not modifiedCount: renewing with the same value is still a success.
    const res = await this.col.updateOne(
      { _id: id, deleted: false, fencingToken, leaseOwner: { $type: 'string' } },
      { $set: { leaseUntil } },
    )
    return res.matchedCount === 1
  }

  async complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    const $set: Record<string, unknown> = { nextRunAt: patch.nextRunAt, updatedAt: now }
    if (patch.lastRunAt !== undefined) $set.lastRunAt = patch.lastRunAt
    if (patch.lastStatus !== undefined) $set.lastStatus = patch.lastStatus
    const res = await this.col.updateOne(
      { _id: id, deleted: false, fencingToken, leaseOwner: { $type: 'string' } },
      { $set, $unset: LEASE_UNSET },
    )
    return res.matchedCount === 1
  }

  async delete(id: string): Promise<void> {
    // Soft delete: the tombstone keeps the fencing token (updatedAt is only a purge hint).
    await this.col.updateOne({ _id: id, deleted: false }, { $set: { deleted: true, updatedAt: Date.now() }, $unset: LEASE_UNSET })
  }

  async list(): Promise<ScheduleRecord[]> {
    return (await this.col.find({ deleted: false }).toArray()).map(fromDoc)
  }
}
