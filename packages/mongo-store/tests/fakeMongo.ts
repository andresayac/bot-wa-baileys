/**
 * In-memory fake of the mongodb v6 driver surface used by MongoStore
 * (MongoClient -> Db -> Collection + find/sort/limit cursor).
 *
 * Hermetic: no network, no real MongoDB. Documents are JSON-round-tripped on
 * the way in and out (like the driver's BSON serialization), so tests never
 * observe shared object references. Filters are plain equality matches —
 * exactly the shapes MongoStore sends (`{ _id }`, `{ chatId }`, `{}`).
 */
import type {
  MongoLikeClient,
  MongoLikeCollection,
  MongoLikeCursor,
  MongoLikeDb,
} from '../src/MongoStore.js'

type Doc = { _id: string } & Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Every filter entry must equal the document's value at that path (top-level only). */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => doc[key] === value)
}

export class FakeCursor<T extends Doc> implements MongoLikeCursor<T> {
  constructor(private docs: T[]) {}

  sort(spec: Record<string, 1 | -1>): this {
    const keys = Object.entries(spec)
    this.docs = [...this.docs].sort((a, b) => {
      for (const [key, dir] of keys) {
        const av = a[key] as number | string
        const bv = b[key] as number | string
        if (av < bv) return -1 * dir
        if (av > bv) return 1 * dir
      }
      return 0
    })
    return this
  }

  limit(count: number): this {
    this.docs = this.docs.slice(0, count)
    return this
  }

  async toArray(): Promise<T[]> {
    return this.docs.map(clone)
  }
}

export class FakeMongoCollection<T extends Doc = Doc> implements MongoLikeCollection<T> {
  readonly docs = new Map<string, T>()
  /** Index specs recorded by createIndex, in call order. */
  readonly indexes: Array<Record<string, 1 | -1>> = []

  constructor(readonly name: string) {}

  async insertOne(doc: T): Promise<{ acknowledged: boolean; insertedId: unknown }> {
    if (this.docs.has(doc._id)) {
      throw new Error(`E11000 duplicate key error collection: fake.${this.name} index: _id_ dup key: { _id: "${doc._id}" }`)
    }
    this.docs.set(doc._id, clone(doc))
    return { acknowledged: true, insertedId: doc._id }
  }

  async updateOne(
    filter: { _id: string },
    update: { $set: Partial<Omit<T, '_id'>> },
    options?: { upsert?: boolean },
  ): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedCount: number; upsertedId: unknown }> {
    const existing = this.docs.get(filter._id)
    if (existing) {
      this.docs.set(filter._id, { ...existing, ...clone(update.$set) })
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }
    }
    if (!options?.upsert) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }
    }
    const doc = { _id: filter._id, ...clone(update.$set) } as T
    this.docs.set(filter._id, doc)
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: filter._id }
  }

  async findOne(filter: { _id: string }): Promise<T | null> {
    const doc = this.docs.get(filter._id)
    return doc ? clone(doc) : null
  }

  find(filter: Record<string, unknown> = {}): FakeCursor<T> {
    return new FakeCursor([...this.docs.values()].filter((d) => matches(d, filter)))
  }

  async deleteOne(filter: { _id: string }): Promise<{ acknowledged: boolean; deletedCount: number }> {
    for (const [id, doc] of this.docs) {
      if (matches(doc, filter)) {
        this.docs.delete(id)
        return { acknowledged: true, deletedCount: 1 }
      }
    }
    return { acknowledged: true, deletedCount: 0 }
  }

  async deleteMany(filter: Record<string, unknown>): Promise<{ acknowledged: boolean; deletedCount: number }> {
    let removed = 0
    for (const [id, doc] of [...this.docs]) {
      if (matches(doc, filter)) {
        this.docs.delete(id)
        removed++
      }
    }
    return { acknowledged: true, deletedCount: removed }
  }

  async createIndex(spec: Record<string, 1 | -1>): Promise<string> {
    this.indexes.push(spec)
    return Object.entries(spec).map(([key, dir]) => `${key}_${dir}`).join('_')
  }
}

export class FakeMongoDb implements MongoLikeDb {
  readonly collections = new Map<string, FakeMongoCollection>()

  constructor(readonly name: string) {}

  collection<T extends Doc>(name: string): MongoLikeCollection<T> {
    let collection = this.collections.get(name)
    if (!collection) {
      collection = new FakeMongoCollection(name)
      this.collections.set(name, collection)
    }
    return collection as unknown as MongoLikeCollection<T>
  }
}

export class FakeMongoClient implements MongoLikeClient {
  readonly dbs = new Map<string, FakeMongoDb>()
  connected = false
  closeCount = 0

  constructor(readonly url?: string) {}

  db(name = 'test'): FakeMongoDb {
    let db = this.dbs.get(name)
    if (!db) {
      db = new FakeMongoDb(name)
      this.dbs.set(name, db)
    }
    return db
  }

  async connect(): Promise<this> {
    this.connected = true
    return this
  }

  async close(): Promise<void> {
    this.connected = false
    this.closeCount++
  }
}
