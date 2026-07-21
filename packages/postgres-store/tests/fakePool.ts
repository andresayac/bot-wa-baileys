/**
 * In-memory fake of the `pg` Pool surface PostgresStore uses.
 *
 * Hermetic: no network, no real PostgreSQL. `query(text, values)` implements
 * EXACTLY the fixed, parameterized statements the store issues — anything else
 * is rejected. Table definitions come from the store's own `CREATE TABLE`
 * statements (column names + types + primary key are parsed), so JSONB values
 * round-trip the way node-postgres does: stored parsed, returned parsed.
 */
import type { PostgresPoolLike, PostgresQueryResult } from '../src/PostgresStore.js'

interface TableDef {
  /** column name -> SQL type (TEXT / BIGINT / JSONB / ...) */
  columns: Map<string, string>
  pk: string
  /** pk value -> row */
  rows: Map<string, Record<string, unknown>>
}

const RE = {
  createTable: /^CREATE TABLE IF NOT EXISTS (\S+) \((.+)\)$/,
  createIndex: /^CREATE INDEX IF NOT EXISTS .+$/,
  insert:
    /^INSERT INTO (\S+) \(([^)]+)\) VALUES \(([^)]+)\) ON CONFLICT \((\w+)\) DO UPDATE SET (.+)$/,
  selectOrderLimit: /^SELECT (.+) FROM (\S+) WHERE (\w+) = \$1 ORDER BY (\w+) (ASC|DESC) LIMIT \$2$/,
  selectWhere: /^SELECT (.+) FROM (\S+) WHERE (\w+) = \$1$/,
  selectAll: /^SELECT (.+) FROM (\S+)$/,
  deleteWhere: /^DELETE FROM (\S+) WHERE (\w+) = \$1$/,
}

export class FakePool implements PostgresPoolLike {
  /** table name -> definition + rows. Inspect for assertions. */
  readonly tables = new Map<string, TableDef>()
  /** Every statement executed, in order. */
  readonly executed: string[] = []
  ended = false

  async query(text: string, values: unknown[] = []): Promise<PostgresQueryResult> {
    if (this.ended) throw new Error('FakePool: cannot use a pool after calling end on the pool')
    const stmt = text.replace(/\s+/g, ' ').trim()
    this.executed.push(stmt)

    let m = RE.createTable.exec(stmt)
    if (m) return this.createTable(m[1], m[2])
    if (RE.createIndex.test(stmt)) return { rows: [], rowCount: 0 }

    m = RE.insert.exec(stmt)
    if (m) return this.upsert(m[1], m[2], m[4], values)

    m = RE.selectOrderLimit.exec(stmt)
    if (m) return this.selectOrderLimit(m[1], m[2], m[3], m[4], m[5], values)

    m = RE.selectWhere.exec(stmt)
    if (m) return this.selectWhere(m[1], m[2], m[3], values)

    m = RE.selectAll.exec(stmt)
    if (m) return this.selectAll(m[1], m[2])

    m = RE.deleteWhere.exec(stmt)
    if (m) return this.deleteWhere(m[1], m[2], values)

    throw new Error(`FakePool: unsupported statement: ${stmt}`)
  }

  async end(): Promise<void> {
    this.ended = true
  }

  /* Statement handlers ------------------------------------------------------ */

  private createTable(name: string, body: string): PostgresQueryResult {
    if (!this.tables.has(name)) {
      const columns = new Map<string, string>()
      let pk = ''
      for (const raw of body.split(',')) {
        const def = raw.trim()
        const cm = /^(\w+)\s+(\w+)/.exec(def)
        if (!cm) continue
        columns.set(cm[1], cm[2].toUpperCase())
        if (/\bPRIMARY KEY\b/.test(def)) pk = cm[1]
      }
      if (!pk) throw new Error(`FakePool: table ${name} has no PRIMARY KEY column`)
      this.tables.set(name, { columns, pk, rows: new Map() })
    }
    return { rows: [], rowCount: 0 }
  }

  /** INSERT ... ON CONFLICT (pk) DO UPDATE SET ... → full-row upsert. */
  private upsert(table: string, colsCsv: string, _pk: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const cols = colsCsv.split(',').map((c) => c.trim())
    const row: Record<string, unknown> = {}
    cols.forEach((col, i) => {
      row[col] = this.convert(def.columns.get(col), values[i])
    })
    const key = String(row[def.pk])
    def.rows.set(key, row)
    return { rows: [], rowCount: 1 }
  }

  private selectWhere(colsCsv: string, table: string, col: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const want = String(values[0])
    const rows = [...def.rows.values()].filter((r) => String(r[col]) === want)
    return this.project(colsCsv, rows)
  }

  private selectAll(colsCsv: string, table: string): PostgresQueryResult {
    return this.project(colsCsv, [...this.table(table).rows.values()])
  }

  private selectOrderLimit(
    colsCsv: string,
    table: string,
    col: string,
    orderCol: string,
    dir: string,
    values: unknown[],
  ): PostgresQueryResult {
    const def = this.table(table)
    const want = String(values[0])
    const limit = Number(values[1])
    const rows = [...def.rows.values()].filter((r) => String(r[col]) === want)
    rows.sort((a, b) => Number(a[orderCol]) - Number(b[orderCol]))
    if (dir.toUpperCase() === 'DESC') rows.reverse()
    return this.project(colsCsv, rows.slice(0, limit))
  }

  private deleteWhere(table: string, col: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const want = String(values[0])
    let removed = 0
    for (const [key, row] of def.rows) {
      if (String(row[col]) === want) {
        def.rows.delete(key)
        removed++
      }
    }
    return { rows: [], rowCount: removed }
  }

  /* Helpers ------------------------------------------------------------------ */

  private table(name: string): TableDef {
    const def = this.tables.get(name)
    if (!def) throw new Error(`FakePool: relation "${name}" does not exist`)
    return def
  }

  /** Mimic node-postgres: JSONB stored parsed, returned parsed; BIGINT as number. */
  private convert(type: string | undefined, value: unknown): unknown {
    if (value == null) return null
    switch (type) {
      case 'JSONB':
      case 'JSON':
        return typeof value === 'string' ? JSON.parse(value) : value
      case 'BIGINT':
      case 'INTEGER':
      case 'INT':
        return Number(value)
      default:
        return String(value)
    }
  }

  /** Project + copy rows (JSON round-trip, like a wire fetch). */
  private project(colsCsv: string, rows: Array<Record<string, unknown>>): PostgresQueryResult {
    const cols = colsCsv.split(',').map((c) => c.trim())
    const out = rows.map((r) => {
      const row: Record<string, unknown> = {}
      for (const c of cols) row[c] = r[c]
      return JSON.parse(JSON.stringify(row)) as Record<string, unknown>
    })
    return { rows: out, rowCount: out.length }
  }
}
