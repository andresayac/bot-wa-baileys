/**
 * The storage seam of the KV-backed journals ({@link KvDurability}).
 *
 * A backend only has to offer versioned compare-and-set on opaque JSON documents plus
 * two sorted indexes; every state transition, lease and fencing rule lives once in
 * `journal.ts`, so all backends behave identically and the shared conformance suite
 * covers them all. Implemented in core by {@link MemoryKv} (and the file backend),
 * by `@bot-wa/postgres-store` (one table, `UPDATE … WHERE version = $n`) and by
 * `@bot-wa/redis-store` (compare-and-set script + sorted sets).
 */

/** The two journals a backend stores. */
export type DurableTable = 'inbox' | 'outbox'

/** A stored document and its opaque version (changes on every write). */
export interface DurableKvEntry {
  value: string
  version: string
}

/**
 * Index scores of a document (epoch ms), `null` = not in that index.
 * `due`: when a non-terminal record next needs attention (retry time or lease expiry).
 * `done`: when a terminal record completed (retention purge).
 */
export interface DurableKvIndex {
  due: number | null
  done: number | null
}

/**
 * Versioned document store with two sorted indexes per table.
 *
 * Contract (checked by `runDurableKvConformance`):
 *  - `insert` writes only when `id` is absent and returns the new version, else `undefined`;
 *  - `replace` writes only when the stored version equals `version` and returns the new
 *    version, else `undefined` (missing document or concurrent write);
 *  - `remove` deletes only when the stored version equals `version`;
 *  - `range` returns ids whose index score is `<= max`, ascending by score, at most `limit`.
 *    It may return ids whose document changed since (callers re-read); it must not miss a
 *    document whose committed score is `<= max` beyond `limit`.
 */
export interface DurableKv {
  start?(): Promise<void>
  stop?(): Promise<void>
  get(table: DurableTable, id: string): Promise<DurableKvEntry | undefined>
  insert(table: DurableTable, id: string, value: string, index: DurableKvIndex): Promise<string | undefined>
  replace(table: DurableTable, id: string, version: string, value: string, index: DurableKvIndex): Promise<string | undefined>
  remove(table: DurableTable, id: string, version: string): Promise<boolean>
  range(table: DurableTable, index: keyof DurableKvIndex, max: number, limit: number): Promise<string[]>
}

interface MemoryRow {
  value: string
  version: number
  index: DurableKvIndex
}

/** Serializable state of a {@link MemoryKv} (the file backend's snapshot). */
export interface MemoryKvSnapshot {
  version: 1
  tables: Record<DurableTable, Array<[id: string, value: string, version: number, due: number | null, done: number | null]>>
}

/** In-process {@link DurableKv}: the reference implementation. */
export class MemoryKv implements DurableKv {
  private readonly tables: Record<DurableTable, Map<string, MemoryRow>> = { inbox: new Map(), outbox: new Map() }

  async get(table: DurableTable, id: string): Promise<DurableKvEntry | undefined> {
    const row = this.tables[table].get(id)
    return row ? { value: row.value, version: String(row.version) } : undefined
  }

  async insert(table: DurableTable, id: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const rows = this.tables[table]
    if (rows.has(id)) return undefined
    rows.set(id, { value, version: 1, index: { ...index } })
    await this.changed()
    return '1'
  }

  async replace(table: DurableTable, id: string, version: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const row = this.tables[table].get(id)
    if (!row || String(row.version) !== version) return undefined
    row.value = value
    row.version += 1
    row.index = { ...index }
    await this.changed()
    return String(row.version)
  }

  async remove(table: DurableTable, id: string, version: string): Promise<boolean> {
    const rows = this.tables[table]
    const row = rows.get(id)
    if (!row || String(row.version) !== version) return false
    rows.delete(id)
    await this.changed()
    return true
  }

  async range(table: DurableTable, index: keyof DurableKvIndex, max: number, limit: number): Promise<string[]> {
    const hits: Array<[string, number]> = []
    for (const [id, row] of this.tables[table]) {
      const score = row.index[index]
      if (score !== null && score <= max) hits.push([id, score])
    }
    hits.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return hits.slice(0, Math.max(0, limit)).map(([id]) => id)
  }

  /** Copy of the whole state. */
  snapshot(): MemoryKvSnapshot {
    const dump = (t: DurableTable) => [...this.tables[t]].map(([id, r]) => [id, r.value, r.version, r.index.due, r.index.done] as [string, string, number, number | null, number | null])
    return { version: 1, tables: { inbox: dump('inbox'), outbox: dump('outbox') } }
  }

  /** Replace the whole state with `snapshot`. @throws {Error} on an invalid snapshot. */
  restore(snapshot: MemoryKvSnapshot): void {
    if (snapshot?.version !== 1 || typeof snapshot.tables !== 'object' || snapshot.tables === null) {
      throw new Error('invalid durability snapshot')
    }
    for (const t of ['inbox', 'outbox'] as const) {
      const rows = new Map<string, MemoryRow>()
      for (const [id, value, version, due, done] of snapshot.tables[t] ?? []) rows.set(id, { value, version, index: { due, done } })
      this.tables[t] = rows
    }
  }

  /** Called after every committed write (the file backend persists here). */
  protected async changed(): Promise<void> {}
}
