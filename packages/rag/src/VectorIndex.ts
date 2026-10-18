/**
 * In-memory vector index: brute-force cosine similarity over every entry.
 * Good for thousands of chunks (a FAQ, a product catalog, a handbook); for
 * millions, plug a real vector DB behind your own `retrieve()`.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RagError } from './errors.js'
import type { RagChunk } from './types.js'

/** A stored chunk with its vector. */
export interface IndexEntry extends RagChunk {
  vector: number[]
  /** sha256 of `text` — lets a rebuild reuse vectors of unchanged chunks. */
  hash: string
  /**
   * Added at runtime (`addText` / `addDocuments` / `addFiles`) rather than
   * from the configured `documents`: kept across restarts by a rebuild.
   */
  runtime?: true
}

export interface SearchOptions {
  /** Max hits. Default 4. */
  topK?: number
  /** Drop hits below this cosine score. Default 0 (keep any positive-or-zero match). */
  minScore?: number
  filter?: (entry: IndexEntry) => boolean
}

export interface SearchHit {
  entry: IndexEntry
  score: number
}

/** On-disk format (version 1). */
export interface SerializedIndex {
  version: 1
  embedder: string
  dimensions: number | null
  entries: IndexEntry[]
}

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex')

function norm(v: readonly number[]): number {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

/** Cosine similarity; 0 when either vector is null. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RagError('INVALID_INDEX', `vector size mismatch: ${a.length} vs ${b.length}`)
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  const n = norm(a) * norm(b)
  return n === 0 ? 0 : dot / n
}

export class VectorIndex {
  private readonly entries = new Map<string, IndexEntry>()
  private readonly norms = new Map<string, number>()
  private dims: number | null = null

  /** @param embedder Id of the vector space (see `Embedder.id`). */
  constructor(readonly embedder: string) {}

  get size(): number { return this.entries.size }
  get dimensions(): number | null { return this.dims }

  /** Insert or replace entries by id. All vectors must share one dimension. */
  upsert(entries: readonly IndexEntry[]): void {
    for (const e of entries) {
      if (!Array.isArray(e.vector) || e.vector.length === 0) throw new RagError('INVALID_INDEX', `entry ${e.id} has no vector`)
      if (this.dims === null) this.dims = e.vector.length
      else if (e.vector.length !== this.dims) {
        throw new RagError('INVALID_INDEX', `entry ${e.id} has ${e.vector.length} dimensions, index has ${this.dims}`)
      }
      this.entries.set(e.id, e)
      this.norms.set(e.id, norm(e.vector))
    }
  }

  get(id: string): IndexEntry | undefined { return this.entries.get(id) }
  all(): IndexEntry[] { return [...this.entries.values()] }

  /** Remove every entry for which `predicate` is true; returns how many. */
  removeWhere(predicate: (entry: IndexEntry) => boolean): number {
    let n = 0
    for (const [id, e] of this.entries) {
      if (!predicate(e)) continue
      this.entries.delete(id)
      this.norms.delete(id)
      n++
    }
    if (this.entries.size === 0) this.dims = null
    return n
  }

  clear(): void {
    this.entries.clear()
    this.norms.clear()
    this.dims = null
  }

  search(vector: readonly number[], options: SearchOptions = {}): SearchHit[] {
    const topK = options.topK ?? 4
    const minScore = options.minScore ?? 0
    if (topK <= 0 || this.entries.size === 0) return []
    if (this.dims !== null && vector.length !== this.dims) {
      throw new RagError('INVALID_INDEX', `query has ${vector.length} dimensions, index has ${this.dims}`)
    }
    const qn = norm(vector)
    if (qn === 0) return []
    const hits: SearchHit[] = []
    for (const [id, entry] of this.entries) {
      if (options.filter && !options.filter(entry)) continue
      const en = this.norms.get(id)!
      if (en === 0) continue
      let dot = 0
      const v = entry.vector
      for (let i = 0; i < v.length; i++) dot += v[i]! * vector[i]!
      const score = dot / (qn * en)
      if (score >= minScore) hits.push({ entry, score })
    }
    hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    return hits.slice(0, topK)
  }

  toJSON(): SerializedIndex {
    return { version: 1, embedder: this.embedder, dimensions: this.dims, entries: this.all() }
  }

  /** Rebuild from {@link toJSON} output. Throws `RagError('INVALID_INDEX')` on a malformed payload. */
  static fromJSON(data: unknown): VectorIndex {
    const d = data as Partial<SerializedIndex> | null
    if (!d || typeof d !== 'object' || d.version !== 1 || typeof d.embedder !== 'string' || !Array.isArray(d.entries)) {
      throw new RagError('INVALID_INDEX', 'not a @bot-wa/rag index (version 1)')
    }
    const index = new VectorIndex(d.embedder)
    for (const e of d.entries) {
      if (!e || typeof e.id !== 'string' || typeof e.text !== 'string' || typeof e.docId !== 'string' || typeof e.source !== 'string') {
        throw new RagError('INVALID_INDEX', 'malformed index entry')
      }
    }
    index.upsert(d.entries)
    return index
  }

  /** Write the index as JSON atomically (temp file + rename), creating parent dirs. */
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.toJSON()), 'utf8')
      await rename(tmp, path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Load an index saved with {@link save}; `undefined` when the file does not exist. */
  static async load(path: string): Promise<VectorIndex | undefined> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      throw err
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (cause) {
      throw new RagError('INVALID_INDEX', `index file ${path} is not valid JSON`, { cause })
    }
    return VectorIndex.fromJSON(json)
  }
}
