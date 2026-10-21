/**
 * TenantDocs — typed, tenant-scoped JSON documents over a core `DurableKv`.
 *
 * Every product package stores its records through this class: one `DurableKv`
 * table per `(family, tenant[, sub…])`, so tenant isolation is enforced by the
 * backend's own primary key (Postgres/SQLite `(tbl, id)`, Redis hash tag). A document
 * is JSON; the backend's opaque version is what the compare-and-set uses, so every
 * mutation is atomic in the backend. Reads parse a fresh copy and validate it with the
 * caller's `parse`, never trusting what the table holds.
 */

import type { DurableKv, DurableKvIndex } from '@botmesh/core'
import { assertTenantId, encodeSegment } from './encode.js'

/** Thrown when a stored document is not valid JSON or fails the caller's `parse`. The message never includes the contents. */
export class CorruptDocumentError extends Error {
  constructor(readonly table: string, readonly id: string, options?: { cause?: unknown }) {
    super(`corrupt document ${JSON.stringify(id)} in table ${JSON.stringify(table)}`, options)
    this.name = 'CorruptDocumentError'
  }
}

/** Thrown by {@link DocTable.update} when the compare-and-set keeps losing (a very hot document). */
export class KvContentionError extends Error {
  constructor(readonly table: string, readonly id: string, readonly attempts: number) {
    super(`too much contention on document ${JSON.stringify(id)} in table ${JSON.stringify(table)} after ${attempts} attempts`)
    this.name = 'KvContentionError'
  }
}

/** How a family of documents is stored and indexed. */
export interface TenantDocsOptions<T> {
  /** Table family, e.g. `['inbox', 'conv']` → tables `product/inbox/conv/<tenant>[/<sub>…]`. */
  family: readonly string[]
  /** Structural validation of a decoded document (throw to reject it). Return the value to hand out. */
  parse: (value: unknown) => T
  /** Score of the `all` index (the backend's `due` index); {@link DocTable.list} returns ascending by it. */
  order: (doc: T) => number
  /** Optional score of the `active` index (the backend's `done` index); `null` keeps the document out of it. */
  active?: (doc: T) => number | null
  /** Compare-and-set retries of {@link DocTable.update} before {@link KvContentionError} (default 32, with a jittered pause between them). */
  attempts?: number
}

/** A document with the opaque backend version it was read at. */
export interface Versioned<T> {
  doc: T
  version: string
}

/** Listing options of {@link DocTable.list}. */
export interface DocListOptions {
  /** `'all'` (default) or the `active` index. */
  index?: 'all' | 'active'
  /** Maximum documents (default 100). */
  limit?: number
  /** Only ids whose score is `<= max` (default +∞). */
  max?: number
}

const TABLE_PREFIX = 'product'
const DEFAULT_ATTEMPTS = 32
const DEFAULT_LIMIT = 100

/** Jittered pause after a lost compare-and-set (0 on the first retry, then up to 2^n ms, capped). */
function backoff(attempt: number): Promise<void> {
  if (attempt === 0) return Promise.resolve()
  const ms = Math.random() * Math.min(64, 2 ** attempt)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The prefix every product table starts with (never used by core's journal tables). */
export const PRODUCT_TABLE_PREFIX = `${TABLE_PREFIX}/`

/** One tenant-scoped table of a {@link TenantDocs} family. */
export class DocTable<T> {
  constructor(
    private readonly kv: DurableKv,
    /** The backend table name (`product/<family…>/<enc tenant>[/<enc sub>…]`). */
    readonly table: string,
    private readonly opts: TenantDocsOptions<T>,
  ) {}

  private indexOf(doc: T): DurableKvIndex {
    const due = this.opts.order(doc)
    if (typeof due !== 'number' || Number.isNaN(due)) throw new TypeError(`order() must return a number for documents of ${this.table}`)
    return { due, done: this.opts.active ? this.opts.active(doc) : null }
  }

  private decode(id: string, raw: string): T {
    try {
      return this.opts.parse(JSON.parse(raw))
    } catch (error) {
      throw new CorruptDocumentError(this.table, id, { cause: error })
    }
  }

  /** The document and its version, or `undefined` when absent. */
  async get(id: string): Promise<Versioned<T> | undefined> {
    const entry = await this.kv.get(this.table, id)
    return entry ? { doc: this.decode(id, entry.value), version: entry.version } : undefined
  }

  /** Create `id`; `undefined` when it already exists. */
  async insert(id: string, doc: T): Promise<Versioned<T> | undefined> {
    const version = await this.kv.insert(this.table, id, JSON.stringify(doc), this.indexOf(doc))
    return version === undefined ? undefined : { doc, version }
  }

  /** Replace `id` only when its stored version is `version`; `undefined` when the compare-and-set lost. */
  async replace(id: string, version: string, doc: T): Promise<Versioned<T> | undefined> {
    const next = await this.kv.replace(this.table, id, version, JSON.stringify(doc), this.indexOf(doc))
    return next === undefined ? undefined : { doc, version: next }
  }

  /** Delete `id` only when its stored version is `version`. */
  remove(id: string, version: string): Promise<boolean> {
    return this.kv.remove(this.table, id, version)
  }

  /**
   * Read-modify-write loop. `fn` receives the current document (or `undefined`) and
   * returns the next one, or `undefined` to leave the table untouched (the current
   * value is then returned). Each attempt is one backend compare-and-set.
   * @throws {KvContentionError} after `attempts` lost compare-and-sets.
   */
  async update(id: string, fn: (current: T | undefined) => T | undefined): Promise<Versioned<T> | undefined> {
    const attempts = this.opts.attempts ?? DEFAULT_ATTEMPTS
    for (let attempt = 0; attempt < attempts; attempt++) {
      await backoff(attempt)
      const current = await this.get(id)
      const next = fn(current?.doc)
      if (next === undefined) return current
      const written = current ? await this.replace(id, current.version, next) : await this.insert(id, next)
      if (written) return written
    }
    throw new KvContentionError(this.table, id, attempts)
  }

  /**
   * Delete `id` whatever its version (retrying a lost compare-and-set). `true` when this
   * call deleted a document.
   */
  async delete(id: string): Promise<boolean> {
    const attempts = this.opts.attempts ?? DEFAULT_ATTEMPTS
    for (let attempt = 0; attempt < attempts; attempt++) {
      await backoff(attempt)
      const entry = await this.kv.get(this.table, id)
      if (!entry) return false
      if (await this.kv.remove(this.table, id, entry.version)) return true
    }
    throw new KvContentionError(this.table, id, attempts)
  }

  /**
   * Up to `limit` documents of the chosen index, ascending by score (ties by id). A
   * document deleted between the index read and its fetch is skipped.
   */
  async list(options: DocListOptions = {}): Promise<T[]> {
    const index = options.index === 'active' ? 'done' : 'due'
    const limit = options.limit ?? DEFAULT_LIMIT
    if (!(Number.isInteger(limit) || limit === Number.POSITIVE_INFINITY) || limit < 0) {
      throw new RangeError('list(): limit must be a non-negative integer')
    }
    if (limit === 0) return []
    const ids = await this.kv.range(this.table, index, options.max ?? Number.POSITIVE_INFINITY, limit)
    const docs: T[] = []
    for (const id of ids) {
      const entry = await this.kv.get(this.table, id)
      if (entry) docs.push(this.decode(id, entry.value))
    }
    return docs
  }
}

/**
 * A family of tenant-scoped document tables. `in(tenantId, …sub)` binds one table;
 * nothing can read or write across tenants through this class because the tenant is
 * part of the backend table name itself.
 */
export class TenantDocs<T> {
  constructor(private readonly kv: DurableKv, private readonly opts: TenantDocsOptions<T>) {
    const family = opts.family
    if (!Array.isArray(family) || family.length === 0 || family.some((s) => typeof s !== 'string' || s === '' || s.includes('/'))) {
      throw new TypeError('TenantDocs: family must be non-empty strings without "/"')
    }
    if (opts.attempts !== undefined && (!Number.isInteger(opts.attempts) || opts.attempts < 1)) {
      throw new RangeError('TenantDocs: attempts must be a positive integer')
    }
  }

  /** The backend table name of a tenant (and optional sub-scopes), every segment percent-encoded. */
  tableName(tenantId: string, ...sub: string[]): string {
    assertTenantId(tenantId)
    const parts = [TABLE_PREFIX, ...this.opts.family, encodeSegment(tenantId)]
    for (const segment of sub) {
      if (typeof segment !== 'string') throw new TypeError('table sub-scope segments must be strings')
      parts.push(encodeSegment(segment))
    }
    return parts.join('/')
  }

  /** The table of one tenant (and optional sub-scopes, e.g. a conversation id for its notes). */
  in(tenantId: string, ...sub: string[]): DocTable<T> {
    return new DocTable(this.kv, this.tableName(tenantId, ...sub), this.opts)
  }
}
