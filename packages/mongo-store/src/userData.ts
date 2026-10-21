/**
 * `ctx.user` storage for {@link MongoStore} (internal).
 *
 * Collection `{prefix}user_data`, one document per (user, namespace,
 * top-level key):
 *
 *   { _id: JSON.stringify([userId, namespace, key]), userId, namespace, key,
 *     value: <JSON text>, expiresAt: <epoch ms> | null, updatedAt }
 *
 * The value is kept as JSON TEXT so arbitrary user keys (`$x`, `a.b`) never
 * clash with MongoDB field-name rules. Expiry is enforced lazily on read and
 * physically by `purge()` (batches of expired `_id`s read through the
 * `{ expiresAt: 1 }` index, each removed with one `deleteMany`); `{ userId: 1, namespace: 1 }` serves the list
 * and namespace/user deletes.
 */

import type { UserDataEntry, UserId } from '@botmesh/core'
import type { MongoLikeCollection } from './MongoStore.js'

export interface UserDataDoc {
  _id: string
  userId: string
  namespace: string
  key: string
  /** JSON text of the value. */
  value: string
  expiresAt: number | null
  updatedAt: number
}

/** Same driver options as MongoStore's own collections: never write `undefined` as null, return Binary as Buffer. */
const UPSERT = { upsert: true, ignoreUndefined: true } as const
const READ = { promoteBuffers: true } as const

const docId = (userId: UserId, namespace: string, key: string): string => JSON.stringify([userId, namespace, key])

const isLive = (doc: UserDataDoc, now: number): boolean => typeof doc.expiresAt !== 'number' || doc.expiresAt > now

function toEntry(doc: UserDataDoc): UserDataEntry {
  const entry: UserDataEntry = {
    userId: doc.userId,
    namespace: doc.namespace,
    key: doc.key,
    value: JSON.parse(doc.value) as unknown,
    updatedAt: doc.updatedAt,
  }
  if (typeof doc.expiresAt === 'number') entry.expiresAt = doc.expiresAt
  return entry
}

/** Default documents per `deleteMany` of {@link MongoUserData.purge}. */
export const DEFAULT_PURGE_BATCH_SIZE = 1000

export class MongoUserData {
  constructor(
    private readonly collection: MongoLikeCollection<UserDataDoc>,
    private readonly batchSize = DEFAULT_PURGE_BATCH_SIZE,
  ) {}

  /** Idempotent index creation (called from MongoStore.start). */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ userId: 1, namespace: 1 })
    await this.collection.createIndex({ expiresAt: 1 })
  }

  async get(userId: UserId, namespace: string, key: string, now: number): Promise<UserDataEntry | undefined> {
    const doc = await this.collection.findOne({ _id: docId(userId, namespace, key) }, READ)
    return doc && isLive(doc, now) ? toEntry(doc) : undefined
  }

  async set(entry: UserDataEntry): Promise<void> {
    const value = JSON.stringify(entry.value) as string | undefined
    if (value === undefined) throw new TypeError('user data value must be JSON-serialisable')
    const _id = docId(entry.userId, entry.namespace, entry.key)
    await this.collection.updateOne(
      { _id },
      {
        $set: {
          userId: entry.userId,
          namespace: entry.namespace,
          key: entry.key,
          value,
          expiresAt: entry.expiresAt ?? null,
          updatedAt: entry.updatedAt,
        },
      },
      UPSERT,
    )
  }

  async delete(userId: UserId, namespace?: string, key?: string): Promise<void> {
    if (namespace === undefined) await this.collection.deleteMany({ userId })
    else if (key === undefined) await this.collection.deleteMany({ userId, namespace })
    else await this.collection.deleteOne({ _id: docId(userId, namespace, key) })
  }

  async list(userId: UserId, namespace: string | undefined, now: number): Promise<UserDataEntry[]> {
    const docs = await this.collection.find(namespace === undefined ? { userId } : { userId, namespace }, READ).toArray()
    return docs.filter((doc) => isLive(doc, now)).map(toEntry)
  }

  /**
   * Delete expired documents `batchSize` at a time — read a batch of `_id`s
   * through the expiry index, then `deleteMany` them (the expiry is re-checked,
   * so a TTL extended in between survives) — until a batch comes back short.
   * One unbounded `deleteMany` over a huge backlog ran as a single long
   * operation.
   */
  async purge(now: number): Promise<number> {
    let total = 0
    for (;;) {
      const batch = await this.collection
        .find({ expiresAt: { $lte: now } }, { projection: { _id: 1 } })
        .limit(this.batchSize)
        .toArray()
      if (batch.length === 0) return total
      const { deletedCount } = await this.collection.deleteMany({
        _id: { $in: batch.map((d) => d._id) },
        expiresAt: { $lte: now },
      })
      total += deletedCount
      if (batch.length < this.batchSize) return total
    }
  }
}
