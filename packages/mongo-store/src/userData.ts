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
 * physically by `purge()` (`deleteMany({ expiresAt: { $lte: now } })`, backed by
 * an `{ expiresAt: 1 }` index); `{ userId: 1, namespace: 1 }` serves the list
 * and namespace/user deletes.
 */

import type { UserDataEntry, UserId } from '@bot-wa/core'
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

export class MongoUserData {
  constructor(private readonly collection: MongoLikeCollection<UserDataDoc>) {}

  /** Idempotent index creation (called from MongoStore.start). */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ userId: 1, namespace: 1 })
    await this.collection.createIndex({ expiresAt: 1 })
  }

  async get(userId: UserId, namespace: string, key: string, now: number): Promise<UserDataEntry | undefined> {
    const doc = await this.collection.findOne({ _id: docId(userId, namespace, key) })
    return doc && isLive(doc, now) ? toEntry(doc) : undefined
  }

  async set(entry: UserDataEntry): Promise<void> {
    const _id = docId(entry.userId, entry.namespace, entry.key)
    await this.collection.updateOne(
      { _id },
      {
        $set: {
          userId: entry.userId,
          namespace: entry.namespace,
          key: entry.key,
          value: JSON.stringify(entry.value),
          expiresAt: entry.expiresAt ?? null,
          updatedAt: entry.updatedAt,
        },
      },
      { upsert: true },
    )
  }

  async delete(userId: UserId, namespace?: string, key?: string): Promise<void> {
    if (namespace === undefined) await this.collection.deleteMany({ userId })
    else if (key === undefined) await this.collection.deleteMany({ userId, namespace })
    else await this.collection.deleteOne({ _id: docId(userId, namespace, key) })
  }

  async list(userId: UserId, namespace: string | undefined, now: number): Promise<UserDataEntry[]> {
    const docs = await this.collection.find(namespace === undefined ? { userId } : { userId, namespace }).toArray()
    return docs.filter((doc) => isLive(doc, now)).map(toEntry)
  }

  async purge(now: number): Promise<number> {
    const { deletedCount } = await this.collection.deleteMany({ expiresAt: { $lte: now } })
    return deletedCount
  }
}
