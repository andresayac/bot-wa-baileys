/**
 * In-memory fake of the mongodb v6 driver surface used by MongoStore
 * (MongoClient -> Db -> Collection + find/sort/skip/limit cursor).
 *
 * Hermetic: no network, no real MongoDB. Fidelity matters more than brevity:
 * the fake reproduces the driver/server behaviour behind bugs the store has
 * really hit, so hermetic tests catch them.
 *  - Values are BSON-cloned, not JSON-cloned: `undefined` becomes null unless
 *    `ignoreUndefined` (always null inside arrays); Dates stay Dates; bytes
 *    (Buffer / Uint8Array) are stored as BSON Binary and come back as a
 *    `Binary` ({@link FakeBinary}) unless the read passes `promoteBuffers`;
 *    `toJSON` is NOT used and functions are dropped; strings are UTF-8, so a
 *    lone surrogate becomes U+FFFD; a key holding U+0000 is rejected.
 *  - `updateOne` applies `$set` and `$unset`.
 *  - Cursors apply sort → skip → limit whatever the call order; `limit(0)`
 *    means no limit and a negative limit its absolute value; `projection`
 *    (inclusion) is honoured.
 *  - Filters: top-level equality plus the `$lte` and `$in` operators —
 *    exactly the shapes MongoStore sends.
 */
import type {
  MongoLikeClient,
  MongoLikeCollection,
  MongoLikeCursor,
  MongoLikeDb,
} from '../src/MongoStore.js'

type Doc = { _id: string } & Record<string, unknown>

interface WriteOptions { ignoreUndefined?: boolean }
interface ReadOptions { promoteBuffers?: boolean; projection?: Record<string, 0 | 1> }

/** Stand-in for the driver's `Binary` (subtype 0): what bytes read back as without `promoteBuffers`. */
export class FakeBinary {
  readonly _bsontype = 'Binary'
  readonly sub_type = 0
  constructor(readonly buffer: Uint8Array) {}
}

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const REPLACEMENT = String.fromCharCode(0xfffd)

class FakeBSONError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BSONError'
  }
}

/** BSON strings are UTF-8: an unpaired surrogate is encoded as U+FFFD. */
const utf8 = (s: string): string => s.replace(LONE_SURROGATES, REPLACEMENT)

/** Serialize a value the way BSON would (into the fake's stored form). */
function toBson(value: unknown, opts: WriteOptions, inArray = false): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { toBSON?: unknown }).toBSON === 'function') {
    value = (value as { toBSON: () => unknown }).toBSON()
  }
  if (value === undefined) return null // object keys are handled by the caller
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return utf8(value)
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return Number(value) // Int64, promoted back to a JS number on read
    case 'function':
    case 'symbol':
      return inArray ? null : undefined // not serialized
  }
  if (value instanceof FakeBinary) return new FakeBinary(Uint8Array.from(value.buffer))
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (value instanceof Uint8Array) return new FakeBinary(Uint8Array.from(value))
  if (Array.isArray(value)) return value.map((v) => toBson(v, opts, true))
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object)
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    const key = String(k)
    if (key.includes('\u0000')) throw new FakeBSONError(`key ${key} must not contain null bytes`)
    if (v === undefined && opts.ignoreUndefined) continue
    const converted = toBson(v, opts)
    if (converted === undefined) continue
    out[utf8(key)] = converted
  }
  return out
}

/** Deserialize a stored value: a fresh copy, Binary promoted to Buffer on request. */
function fromBson(value: unknown, opts: ReadOptions): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof FakeBinary) {
    return opts.promoteBuffers ? Buffer.from(value.buffer) : new FakeBinary(Uint8Array.from(value.buffer))
  }
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (Array.isArray(value)) return value.map((v) => fromBson(v, opts))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = fromBson(v, opts)
  return out
}

function read<T>(doc: T, opts: ReadOptions = {}): T {
  const copy = fromBson(doc, opts) as Record<string, unknown>
  const projection = opts.projection
  if (!projection || Object.keys(projection).length === 0) return copy as T
  const included = Object.keys(projection).filter((k) => projection[k] === 1)
  if (included.length === 0) {
    // Exclusion projection.
    for (const k of Object.keys(projection)) delete copy[k]
    return copy as T
  }
  // Inclusion projection: the listed fields, plus _id unless excluded.
  const out: Record<string, unknown> = {}
  if (projection._id !== 0) out._id = copy._id
  for (const k of included) if (k in copy) out[k] = copy[k]
  return out as T
}

/** An operator object such as `{ $lte: 5 }` (every key starts with `$`). */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}

/** The query operators MongoStore sends. */
function applyOperator(op: string, actual: unknown, operand: unknown): boolean {
  switch (op) {
    case '$lte':
      // Like MongoDB's type bracketing: a number bound never matches null/missing.
      return typeof actual === 'number' && typeof operand === 'number' && actual <= operand
    case '$in':
      if (!Array.isArray(operand)) throw new Error('FakeMongo: $in needs an array')
      return operand.some((v) => v === actual || (v === null && actual === undefined))
    default:
      throw new Error(`FakeMongo: unsupported query operator ${op}`)
  }
}

/**
 * Every filter entry must match the document's top-level value: plain
 * equality, or an operator object (`{ $lte: n }`, `{ $in: [...] }`) evaluated per operator.
 */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) =>
    isOperatorObject(value)
      ? Object.entries(value).every(([op, operand]) => applyOperator(op, doc[key], operand))
      : doc[key] === value,
  )
}

/** BSON sort order for the scalar types the store sorts on: null/missing < numbers < strings. */
function rank(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number') return 1
  if (typeof v === 'string') return 2
  return 3
}

function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 1 || ra === 2) return (a as number | string) < (b as number | string) ? -1 : (a as number | string) > (b as number | string) ? 1 : 0
  return 0
}

export class FakeCursor<T extends Doc> implements MongoLikeCursor<T> {
  private sortSpec?: Array<[string, 1 | -1]>
  private skipCount = 0
  private limitCount = 0

  constructor(private readonly docs: T[], private readonly opts: ReadOptions = {}) {}

  sort(spec: Record<string, 1 | -1>): this {
    this.sortSpec = Object.entries(spec)
    return this
  }

  /** MongoDB: 0 = no limit, a negative n = n (single batch). */
  limit(count: number): this {
    if (!Number.isInteger(count)) throw new Error('FakeMongo: limit must be an integer')
    this.limitCount = Math.abs(count)
    return this
  }

  skip(count: number): this {
    if (!Number.isInteger(count) || count < 0) throw new Error('FakeMongo: skip must be a non-negative integer')
    this.skipCount = count
    return this
  }

  /** Server order of operations: sort, then skip, then limit. */
  async toArray(): Promise<T[]> {
    let docs = [...this.docs]
    const keys = this.sortSpec
    if (keys) {
      docs.sort((a, b) => {
        for (const [key, dir] of keys) {
          const c = compareValues(a[key], b[key])
          if (c !== 0) return c * dir
        }
        return 0
      })
    }
    docs = docs.slice(this.skipCount)
    if (this.limitCount > 0) docs = docs.slice(0, this.limitCount)
    return docs.map((d) => read(d, this.opts))
  }
}

export class FakeMongoCollection<T extends Doc = Doc> implements MongoLikeCollection<T> {
  readonly docs = new Map<string, T>()
  /** Index specs recorded by createIndex, in call order. */
  readonly indexes: Array<Record<string, 1 | -1>> = []

  constructor(readonly name: string) {}

  async insertOne(doc: T, options: WriteOptions = {}): Promise<{ acknowledged: boolean; insertedId: unknown }> {
    if (this.docs.has(doc._id)) {
      throw new Error(`E11000 duplicate key error collection: fake.${this.name} index: _id_ dup key: { _id: "${doc._id}" }`)
    }
    this.docs.set(doc._id, toBson(doc, options) as T)
    return { acknowledged: true, insertedId: doc._id }
  }

  async updateOne(
    filter: { _id: string },
    update: { $set: Partial<Omit<T, '_id'>>; $unset?: Record<string, ''> },
    options: { upsert?: boolean } & WriteOptions = {},
  ): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedCount: number; upsertedId: unknown }> {
    for (const key of Object.keys(update)) {
      if (key !== '$set' && key !== '$unset') throw new Error(`FakeMongo: unsupported update operator ${key}`)
    }
    const set = toBson(update.$set ?? {}, options) as Record<string, unknown>
    const unset = Object.keys(update.$unset ?? {})
    for (const key of unset) {
      if (key in set) throw new Error(`Updating the path '${key}' would create a conflict at '${key}'`)
    }
    const apply = (base: Record<string, unknown>): T => {
      const next = { ...base, ...set }
      for (const key of unset) delete next[key]
      return next as T
    }
    const existing = this.docs.get(filter._id)
    if (existing) {
      this.docs.set(filter._id, apply(existing))
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }
    }
    if (!options.upsert) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }
    }
    this.docs.set(filter._id, apply({ _id: filter._id }))
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: filter._id }
  }

  async findOne(filter: { _id: string }, options: ReadOptions = {}): Promise<T | null> {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return read(doc, options)
    }
    return null
  }

  find(filter: Record<string, unknown> = {}, options: ReadOptions = {}): FakeCursor<T> {
    return new FakeCursor([...this.docs.values()].filter((d) => matches(d, filter)), options)
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
