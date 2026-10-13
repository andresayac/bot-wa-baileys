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
  /** Primary-key column(s): a column-level PRIMARY KEY or a table-level `PRIMARY KEY (a, b)`. */
  pk: string[]
  /** pk value(s) -> row */
  rows: Map<string, Record<string, unknown>>
}

type Row = Record<string, unknown>
type Predicate = (row: Row, values: unknown[]) => boolean

const RE = {
  createTable: /^CREATE TABLE IF NOT EXISTS (\S+) \((.+)\)$/,
  createIndex: /^CREATE INDEX IF NOT EXISTS .+$/,
  insert:
    /^INSERT INTO (\S+) \(([^)]+)\) VALUES \(([^)]+)\) ON CONFLICT \(([\w, ]+)\) DO UPDATE SET (.+)$/,
  selectOrderLimit: /^SELECT (.+) FROM (\S+) WHERE (\w+) = \$1 ORDER BY (\w+) (ASC|DESC) LIMIT \$2$/,
  selectWhere: /^SELECT (.+) FROM (\S+) WHERE (\w+) = \$1$/,
  selectAll: /^SELECT (.+) FROM (\S+)$/,
  deleteWhere: /^DELETE FROM (\S+) WHERE (\w+) = \$1$/,
  deleteTrim: /^DELETE FROM (\S+) WHERE (\w+) = \$1 AND id NOT IN \(SELECT id FROM \S+ WHERE \w+ = \$1 ORDER BY (\w+) DESC, id DESC LIMIT \$2\)$/,
  /** Multi-predicate WHERE (user_data statements) — see {@link parseWhere}. */
  selectWhereAnd: /^SELECT (.+?) FROM (\S+) WHERE (.+)$/,
  deleteWhereAnd: /^DELETE FROM (\S+) WHERE (.+)$/,
}

/** Split on `sep` only at parenthesis depth 0. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i))
      start = i + sep.length
      i += sep.length - 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim())
}

/**
 * Parse a conjunction of the predicate shapes PostgresStore's user-data SQL
 * uses: `col = $n`, `(col IS NULL OR col > $n)`, `col IS NOT NULL`, `col <= $n`.
 * Anything else throws, so drift to new SQL fails loudly.
 */
function parseWhere(where: string): Predicate[] {
  return splitTopLevel(where, ' AND ').map((clause): Predicate => {
    let m = /^(\w+) = \$(\d+)$/.exec(clause)
    if (m) {
      const [, col, n] = m
      return (row, values) => row[col!] != null && String(row[col!]) === String(values[Number(n) - 1])
    }
    m = /^\((\w+) IS NULL OR (\w+) > \$(\d+)\)$/.exec(clause)
    if (m && m[1] === m[2]) {
      const [, col, , n] = m
      return (row, values) => row[col!] == null || Number(row[col!]) > Number(values[Number(n) - 1])
    }
    m = /^(\w+) IS NOT NULL$/.exec(clause)
    if (m) {
      const [, col] = m
      return (row) => row[col!] != null
    }
    m = /^(\w+) <= \$(\d+)$/.exec(clause)
    if (m) {
      const [, col, n] = m
      return (row, values) => row[col!] != null && Number(row[col!]) <= Number(values[Number(n) - 1])
    }
    throw new Error(`FakePool: unsupported WHERE clause: ${clause}`)
  })
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

    m = RE.deleteTrim.exec(stmt)
    if (m) return this.deleteTrim(m[1], m[2], m[3], values)

    m = RE.deleteWhere.exec(stmt)
    if (m) return this.deleteWhere(m[1], m[2], values)

    m = RE.selectWhereAnd.exec(stmt)
    if (m) return this.selectWhereAnd(m[1], m[2], m[3], values)

    m = RE.deleteWhereAnd.exec(stmt)
    if (m) return this.deleteWhereAnd(m[1], m[2], values)

    throw new Error(`FakePool: unsupported statement: ${stmt}`)
  }

  async end(): Promise<void> {
    this.ended = true
  }

  /* Statement handlers ------------------------------------------------------ */

  private createTable(name: string, body: string): PostgresQueryResult {
    if (!this.tables.has(name)) {
      const columns = new Map<string, string>()
      let pk: string[] = []
      for (const def of splitTopLevel(body, ',')) {
        const tableKey = /^PRIMARY KEY \(([^)]+)\)$/.exec(def)
        if (tableKey) {
          pk = tableKey[1].split(',').map((c) => c.trim())
          continue
        }
        const cm = /^(\w+)\s+(\w+)/.exec(def)
        if (!cm) continue
        columns.set(cm[1], cm[2].toUpperCase())
        if (/\bPRIMARY KEY\b/.test(def)) pk = [cm[1]]
      }
      if (!pk.length) throw new Error(`FakePool: table ${name} has no PRIMARY KEY`)
      for (const col of pk) {
        if (!columns.has(col)) throw new Error(`FakePool: PRIMARY KEY column ${col} is not defined in ${name}`)
      }
      this.tables.set(name, { columns, pk, rows: new Map() })
    }
    return { rows: [], rowCount: 0 }
  }

  /** INSERT ... ON CONFLICT (pk[, ...]) DO UPDATE SET ... → full-row upsert. */
  private upsert(table: string, colsCsv: string, conflictCsv: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const conflict = conflictCsv.split(',').map((c) => c.trim())
    if (conflict.join(',') !== def.pk.join(',')) {
      throw new Error(`FakePool: ON CONFLICT (${conflict.join(', ')}) does not match the primary key of ${table}`)
    }
    const cols = colsCsv.split(',').map((c) => c.trim())
    const row: Record<string, unknown> = {}
    cols.forEach((col, i) => {
      row[col] = this.convert(def.columns.get(col), values[i])
    })
    def.rows.set(this.rowKey(def, row), row)
    return { rows: [], rowCount: 1 }
  }

  /** SELECT cols FROM t WHERE <conjunction> (user_data reads). */
  private selectWhereAnd(colsCsv: string, table: string, where: string, values: unknown[]): PostgresQueryResult {
    const predicates = parseWhere(where)
    const rows = [...this.table(table).rows.values()].filter((row) => predicates.every((p) => p(row, values)))
    return this.project(colsCsv, rows)
  }

  /** DELETE FROM t WHERE <conjunction> (user_data deletes + purge). */
  private deleteWhereAnd(table: string, where: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const predicates = parseWhere(where)
    let removed = 0
    for (const [key, row] of def.rows) {
      if (predicates.every((p) => p(row, values))) {
        def.rows.delete(key)
        removed++
      }
    }
    return { rows: [], rowCount: removed }
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

  /** DELETE ... WHERE chat = $1 AND id NOT IN (newest $2 by timestamp desc, id desc). */
  private deleteTrim(table: string, col: string, orderCol: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const want = String(values[0])
    const keep = Number(values[1])
    const matching = [...def.rows.values()].filter((r) => String(r[col]) === want)
    matching.sort((a, b) => Number(b[orderCol]) - Number(a[orderCol]) || (String(a.id) < String(b.id) ? 1 : -1))
    const keepIds = new Set(matching.slice(0, keep).map((r) => String(r.id)))
    let removed = 0
    for (const [key, row] of def.rows) {
      if (String(row[col]) === want && !keepIds.has(String(row.id))) {
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

  /** Map key for a row: its primary-key value(s), unambiguously joined. */
  private rowKey(def: TableDef, row: Row): string {
    return def.pk.length === 1 ? String(row[def.pk[0]]) : JSON.stringify(def.pk.map((c) => String(row[c])))
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
