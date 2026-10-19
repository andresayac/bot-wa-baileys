/**
 * In-memory fake of the `pg` Pool surface PostgresStore uses.
 *
 * Hermetic: no network, no real PostgreSQL. `query(text, values)` implements
 * EXACTLY the fixed, parameterized statements the store issues — anything else
 * is rejected. Table definitions come from the store's own `CREATE TABLE`
 * statements (column names + types + primary key are parsed).
 *
 * Fidelity matters more than brevity here: the fake reproduces the server
 * behaviour behind bugs the store has really hit, so hermetic tests catch them.
 *  - Parameters are bound like node-postgres + the server: the count must match
 *    the placeholders (08P01); a raw U+0000 in any text value is 22021; raw
 *    lone surrogates are UTF-8 encoded by Node as U+FFFD.
 *  - JSONB input rejects the `\u0000` escape (22P05) and escaped unpaired
 *    surrogates (22P02); BIGINT input rejects anything that is not an integer
 *    literal (22P02) or does not fit in 64 bits (22003).
 *  - Results come back like node-postgres: JSONB parsed, BIGINT as a string.
 *  - `ON CONFLICT ... DO UPDATE SET` evaluates each assignment — `col =
 *    EXCLUDED.col` and the atomic JSONB merge `col = (t.col - $n::text[]) ||
 *    $m::jsonb` — instead of replacing the row with the INSERT payload.
 *  - `ORDER BY` honours every key (BIGINT numerically, TEXT by code unit, i.e.
 *    C collation); `LIMIT` must be a non-negative integer (22P02 / 2201W).
 */
import { EventEmitter } from 'node:events'
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
type OrderKey = { col: string; desc: boolean }

/** A server error with its SQLSTATE, shaped like pg's DatabaseError. */
export class FakePgError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'error'
  }
}

const RE = {
  createTable: /^CREATE TABLE IF NOT EXISTS (\S+) \((.+)\)$/,
  createIndex: /^CREATE INDEX IF NOT EXISTS .+$/,
  insert:
    /^INSERT INTO (\S+) \(([^)]+)\) VALUES \(([^)]+)\) ON CONFLICT \(([\w, ]+)\) DO UPDATE SET (.+)$/,
  selectOrderLimit: /^SELECT (.+) FROM (\S+) WHERE (\w+) = \$1 ORDER BY (.+) LIMIT \$2$/,
  selectWhere: /^SELECT (.+) FROM (\S+) WHERE (\w+) = \$1$/,
  selectAll: /^SELECT (.+) FROM (\S+)$/,
  deleteWhere: /^DELETE FROM (\S+) WHERE (\w+) = \$1$/,
  deleteTrim: /^DELETE FROM (\S+) WHERE (\w+) = \$1 AND id NOT IN \(SELECT id FROM (\S+) WHERE (\w+) = \$1 ORDER BY (.+) LIMIT \$2\)$/,
  /** Multi-predicate WHERE (user_data statements) — see {@link parseWhere}. */
  selectWhereAnd: /^SELECT (.+?) FROM (\S+) WHERE (.+)$/,
  deleteWhereAnd: /^DELETE FROM (\S+) WHERE (.+)$/,
}

/** An unpaired UTF-16 surrogate (code-unit regex: no `u` flag on purpose). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g')

const BIGINT_MIN = -(2n ** 63n)
const BIGINT_MAX = 2n ** 63n - 1n

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

/* Parameter input (what the server's type input functions do) -------------- */

/** node-postgres `prepareValue` for the scalar shapes the store sends. */
function wireText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Text as the server receives it: Node encodes lone surrogates as U+FFFD
 * (UTF-8 cannot carry them) and the server refuses a NUL byte in any text.
 */
function serverText(value: string): string {
  if (value.includes('\u0000')) {
    throw new FakePgError('22021', 'invalid byte sequence for encoding "UTF8": 0x00')
  }
  return value.replace(LONE_SURROGATES, '\uFFFD')
}

function bigintInput(value: unknown): string {
  const text = serverText(wireText(value)).trim()
  if (!/^[+-]?\d+$/.test(text)) {
    throw new FakePgError('22P02', `invalid input syntax for type bigint: "${wireText(value)}"`)
  }
  const n = BigInt(text)
  if (n < BIGINT_MIN || n > BIGINT_MAX) {
    throw new FakePgError('22003', `value "${text}" is out of range for type bigint`)
  }
  return n.toString()
}

/** Walk every string (keys too) of a parsed JSON value. */
function eachString(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) value.forEach((v) => eachString(v, visit))
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k)
      eachString(v, visit)
    }
  }
}

function jsonbInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    // node-postgres sends a JS array as a PostgreSQL array literal ({...}), not JSON.
    throw new FakePgError('22P02', 'invalid input syntax for type json')
  }
  const text = serverText(wireText(value))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new FakePgError('22P02', 'invalid input syntax for type json')
  }
  // Raw lone surrogates were already replaced in transit, so any left here
  // came from a `\uXXXX` escape — exactly what jsonb's parser rejects.
  eachString(parsed, (s) => {
    if (s.includes('\u0000')) throw new FakePgError('22P05', 'unsupported Unicode escape sequence')
    if (LONE_SURROGATE.test(s)) {
      throw new FakePgError('22P02', 'invalid input syntax for type json (Unicode low surrogate must follow a high surrogate)')
    }
  })
  return parsed
}

function textArrayInput(value: unknown): string[] {
  if (!Array.isArray(value)) throw new FakePgError('22P02', 'malformed array literal')
  return value.map((v) => serverText(wireText(v)))
}

/** Convert a bound value for a column/cast type; null stays null. */
function input(type: string | undefined, value: unknown): unknown {
  if (value == null) return null
  switch (type) {
    case 'JSONB':
    case 'JSON':
      return jsonbInput(value)
    case 'BIGINT':
      return bigintInput(value)
    case 'TEXT[]':
      return textArrayInput(value)
    default:
      return serverText(wireText(value))
  }
}

/** Compare two stored column values of one type (BIGINT numerically, TEXT by code unit). */
function compare(type: string | undefined, a: unknown, b: unknown): number {
  if (a == null || b == null) {
    // PostgreSQL sorts NULL as larger than any value.
    return a == null ? (b == null ? 0 : 1) : -1
  }
  if (type === 'BIGINT') {
    const x = BigInt(a as string)
    const y = BigInt(b as string)
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (type === 'JSONB' || type === 'JSON') throw new Error('FakePool: comparing JSONB values is not modelled')
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function parseOrderBy(def: TableDef, text: string): OrderKey[] {
  return text.split(',').map((part) => {
    const m = /^(\w+)(?: (ASC|DESC))?$/i.exec(part.trim())
    if (!m || !def.columns.has(m[1])) throw new Error(`FakePool: unsupported ORDER BY key: ${part}`)
    return { col: m[1], desc: (m[2] ?? 'ASC').toUpperCase() === 'DESC' }
  })
}

function sortRows(def: TableDef, rows: Row[], keys: OrderKey[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const c = compare(def.columns.get(col), a[col], b[col])
      if (c !== 0) return desc ? -c : c
    }
    return 0
  })
}

/** `LIMIT $n` input: a non-negative bigint, NULL = no limit. */
function limitInput(value: unknown): number {
  if (value == null) return Infinity
  const n = Number(bigintInput(value))
  if (n < 0) throw new FakePgError('2201W', 'LIMIT must not be negative')
  return n
}

/**
 * Parse a conjunction of the predicate shapes PostgresStore's user-data SQL
 * uses: `col = $n`, `(col IS NULL OR col > $n)`, `col IS NOT NULL`, `col <= $n`.
 * Bound values are converted with the column's type (a BIGINT bound must be an
 * integer). Anything else throws, so drift to new SQL fails loudly.
 */
function parseWhere(def: TableDef, where: string): Predicate[] {
  const typed = (col: string, values: unknown[], n: string): unknown => {
    if (!def.columns.has(col)) throw new FakePgError('42703', `column "${col}" does not exist`)
    return input(def.columns.get(col), values[Number(n) - 1])
  }
  return splitTopLevel(where, ' AND ').map((clause): Predicate => {
    let m = /^(\w+) = \$(\d+)$/.exec(clause)
    if (m) {
      const [, col, n] = m
      return (row, values) => {
        const want = typed(col!, values, n!)
        return row[col!] != null && want != null && compare(def.columns.get(col!), row[col!], want) === 0
      }
    }
    m = /^\((\w+) IS NULL OR (\w+) > \$(\d+)\)$/.exec(clause)
    if (m && m[1] === m[2]) {
      const [, col, , n] = m
      return (row, values) => {
        const bound = typed(col!, values, n!)
        return row[col!] == null || (bound != null && compare(def.columns.get(col!), row[col!], bound) > 0)
      }
    }
    m = /^(\w+) IS NOT NULL$/.exec(clause)
    if (m) {
      const [, col] = m
      return (row) => row[col!] != null
    }
    m = /^(\w+) <= \$(\d+)$/.exec(clause)
    if (m) {
      const [, col, n] = m
      return (row, values) => {
        const bound = typed(col!, values, n!)
        return row[col!] != null && bound != null && compare(def.columns.get(col!), row[col!], bound) <= 0
      }
    }
    throw new Error(`FakePool: unsupported WHERE clause: ${clause}`)
  })
}

/** The highest `$n` placeholder of a statement. */
function placeholderCount(stmt: string): number {
  let max = 0
  for (const m of stmt.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]))
  return max
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An EventEmitter like pg's Pool, so tests can emit the 'error' of an idle client. */
export class FakePool extends EventEmitter implements PostgresPoolLike {
  /** table name -> definition + rows. Inspect for assertions. */
  readonly tables = new Map<string, TableDef>()
  /** Every statement executed, in order. */
  readonly executed: string[] = []
  ended = false

  async query(text: string, values: unknown[] = []): Promise<PostgresQueryResult> {
    if (this.ended) throw new Error('FakePool: cannot use a pool after calling end on the pool')
    const stmt = text.replace(/\s+/g, ' ').trim()
    this.executed.push(stmt)

    const required = placeholderCount(stmt)
    if (values.length !== required) {
      throw new FakePgError('08P01', `bind message supplies ${values.length} parameters, but prepared statement "" requires ${required}`)
    }

    let m = RE.createTable.exec(stmt)
    if (m) return this.createTable(m[1], m[2])
    if (RE.createIndex.test(stmt)) return { rows: [], rowCount: 0 }

    m = RE.insert.exec(stmt)
    if (m) return this.upsert(m[1], m[2], m[3], m[4], m[5], values)

    m = RE.selectOrderLimit.exec(stmt)
    if (m) return this.selectOrderLimit(m[1], m[2], m[3], m[4], values)

    m = RE.selectWhere.exec(stmt)
    if (m) return this.selectWhere(m[1], m[2], m[3], values)

    m = RE.selectAll.exec(stmt)
    if (m) return this.selectAll(m[1], m[2])

    m = RE.deleteTrim.exec(stmt)
    if (m) {
      if (m[3] !== m[1] || m[4] !== m[2]) throw new Error(`FakePool: unsupported trim statement: ${stmt}`)
      return this.deleteTrim(m[1], m[2], m[5], values)
    }

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
      const notNull = new Set<string>()
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
        if (/\bNOT NULL\b|\bPRIMARY KEY\b/.test(def)) notNull.add(cm[1])
      }
      if (!pk.length) throw new Error(`FakePool: table ${name} has no PRIMARY KEY`)
      for (const col of pk) {
        if (!columns.has(col)) throw new Error(`FakePool: PRIMARY KEY column ${col} is not defined in ${name}`)
        notNull.add(col)
      }
      this.tables.set(name, { columns, pk, rows: new Map() })
      this.notNull.set(name, notNull)
    }
    return { rows: [], rowCount: 0 }
  }

  /** table name -> NOT NULL columns (from the CREATE TABLE definition). */
  private readonly notNull = new Map<string, Set<string>>()

  /**
   * INSERT (cols) VALUES ($i, ...) ON CONFLICT (pk) DO UPDATE SET <assignments>.
   * Every bound value is type-checked first (the server binds them all), then
   * either the new row is inserted or each SET assignment is evaluated against
   * the existing row.
   */
  private upsert(
    table: string,
    colsCsv: string,
    valuesCsv: string,
    conflictCsv: string,
    setCsv: string,
    values: unknown[],
  ): PostgresQueryResult {
    const def = this.table(table)
    const conflict = conflictCsv.split(',').map((c) => c.trim())
    if (conflict.join(',') !== def.pk.join(',')) {
      throw new Error(`FakePool: ON CONFLICT (${conflict.join(', ')}) does not match the primary key of ${table}`)
    }
    const cols = colsCsv.split(',').map((c) => c.trim())
    const placeholders = valuesCsv.split(',').map((p) => p.trim())
    if (placeholders.length !== cols.length) throw new Error(`FakePool: column/value count mismatch in INSERT INTO ${table}`)
    const excluded: Row = {}
    cols.forEach((col, i) => {
      if (!def.columns.has(col)) throw new FakePgError('42703', `column "${col}" of relation "${table}" does not exist`)
      const pm = /^\$(\d+)$/.exec(placeholders[i]!)
      if (!pm) throw new Error(`FakePool: unsupported VALUES item ${placeholders[i]}`)
      excluded[col] = input(def.columns.get(col), values[Number(pm[1]) - 1])
    })
    for (const col of def.columns.keys()) if (!(col in excluded)) excluded[col] = null

    // Parse + bind every SET assignment up front (binding errors fire even when no row conflicts).
    const assignments = splitTopLevel(setCsv, ',').map((a) => this.assignment(table, def, a, values))

    const key = this.rowKey(def, excluded)
    const existing = def.rows.get(key)
    if (!existing) {
      this.checkNotNull(table, excluded)
      def.rows.set(key, excluded)
      return { rows: [], rowCount: 1 }
    }
    const updated: Row = { ...existing }
    for (const apply of assignments) apply(existing, excluded, updated)
    this.checkNotNull(table, updated)
    def.rows.set(key, updated)
    return { rows: [], rowCount: 1 }
  }

  /** One `col = <expr>` of DO UPDATE SET, as (existing, excluded, target) => void. */
  private assignment(
    table: string,
    def: TableDef,
    text: string,
    values: unknown[],
  ): (existing: Row, excluded: Row, target: Row) => void {
    let m = /^(\w+) = EXCLUDED\.(\w+)$/.exec(text)
    if (m) {
      const [, col, src] = m
      if (!def.columns.has(col!) || !def.columns.has(src!)) throw new FakePgError('42703', `column "${col}" does not exist`)
      return (_existing, excluded, target) => { target[col!] = excluded[src!] }
    }
    // Atomic shallow merge: `col = (t.col - $n::text[]) || $m::jsonb` or `|| EXCLUDED.col`.
    m = /^(\w+) = \((\S+)\.(\w+) - \$(\d+)::text\[\]\) \|\| (?:\$(\d+)::jsonb|EXCLUDED\.(\w+))$/.exec(text)
    if (m) {
      const [, col, ref, refCol, keysN, patchN, patchCol] = m
      if (ref !== table || refCol !== col || def.columns.get(col!) !== 'JSONB' || (patchCol && patchCol !== col)) {
        throw new Error(`FakePool: unsupported DO UPDATE SET assignment: ${text}`)
      }
      const keys = input('TEXT[]', values[Number(keysN) - 1]) as string[] | null
      const boundPatch = patchN ? input('JSONB', values[Number(patchN) - 1]) : undefined
      return (existing, excluded, target) => {
        const patch = patchN ? boundPatch : excluded[col!]
        const current = existing[col!]
        if (current == null || patch == null || keys == null) {
          target[col!] = null // NULL propagates through `-` and `||`
          return
        }
        if (!isPlainObject(current) || !isPlainObject(patch)) {
          throw new Error('FakePool: jsonb `-` / `||` on non-objects is not modelled')
        }
        const kept = Object.fromEntries(Object.entries(current).filter(([k]) => !keys.includes(k)))
        target[col!] = { ...kept, ...patch }
      }
    }
    throw new Error(`FakePool: unsupported DO UPDATE SET assignment: ${text}`)
  }

  private checkNotNull(table: string, row: Row): void {
    for (const col of this.notNull.get(table) ?? []) {
      if (row[col] == null) {
        throw new FakePgError('23502', `null value in column "${col}" of relation "${table}" violates not-null constraint`)
      }
    }
  }

  /** SELECT cols FROM t WHERE <conjunction> (user_data reads). */
  private selectWhereAnd(colsCsv: string, table: string, where: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const predicates = parseWhere(def, where)
    const rows = [...def.rows.values()].filter((row) => predicates.every((p) => p(row, values)))
    return this.project(def, colsCsv, rows)
  }

  /** DELETE FROM t WHERE <conjunction> (user_data deletes + purge). */
  private deleteWhereAnd(table: string, where: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const predicates = parseWhere(def, where)
    let removed = 0
    for (const [key, row] of def.rows) {
      if (predicates.every((p) => p(row, values))) {
        def.rows.delete(key)
        removed++
      }
    }
    return { rows: [], rowCount: removed }
  }

  /** Rows whose `col` equals the bound `$1` (typed like the column). */
  private rowsWhereEq(def: TableDef, col: string, value: unknown): Row[] {
    if (!def.columns.has(col)) throw new FakePgError('42703', `column "${col}" does not exist`)
    const type = def.columns.get(col)
    const want = input(type, value)
    if (want == null) return []
    return [...def.rows.values()].filter((r) => r[col] != null && compare(type, r[col], want) === 0)
  }

  private selectWhere(colsCsv: string, table: string, col: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    return this.project(def, colsCsv, this.rowsWhereEq(def, col, values[0]))
  }

  private selectAll(colsCsv: string, table: string): PostgresQueryResult {
    const def = this.table(table)
    return this.project(def, colsCsv, [...def.rows.values()])
  }

  private selectOrderLimit(colsCsv: string, table: string, col: string, orderBy: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const rows = this.rowsWhereEq(def, col, values[0])
    const limit = limitInput(values[1])
    return this.project(def, colsCsv, sortRows(def, rows, parseOrderBy(def, orderBy)).slice(0, limit))
  }

  private deleteRows(def: TableDef, doomed: Row[]): PostgresQueryResult {
    for (const row of doomed) def.rows.delete(this.rowKey(def, row))
    return { rows: [], rowCount: doomed.length }
  }

  private deleteWhere(table: string, col: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    return this.deleteRows(def, this.rowsWhereEq(def, col, values[0]))
  }

  /** DELETE ... WHERE chat = $1 AND id NOT IN (SELECT id ... ORDER BY <keys> LIMIT $2). */
  private deleteTrim(table: string, col: string, orderBy: string, values: unknown[]): PostgresQueryResult {
    const def = this.table(table)
    const matching = this.rowsWhereEq(def, col, values[0])
    const keep = limitInput(values[1])
    const kept = new Set(sortRows(def, matching, parseOrderBy(def, orderBy)).slice(0, keep))
    return this.deleteRows(def, matching.filter((r) => !kept.has(r)))
  }

  /* Helpers ------------------------------------------------------------------ */

  private table(name: string): TableDef {
    const def = this.tables.get(name)
    if (!def) throw new FakePgError('42P01', `relation "${name}" does not exist`)
    return def
  }

  /** Map key for a row: its primary-key value(s), unambiguously joined. */
  private rowKey(def: TableDef, row: Row): string {
    return def.pk.length === 1 ? String(row[def.pk[0]]) : JSON.stringify(def.pk.map((c) => String(row[c])))
  }

  /** Project + copy rows like a wire fetch: JSONB parsed (fresh copy), BIGINT/TEXT as strings. */
  private project(def: TableDef, colsCsv: string, rows: Row[]): PostgresQueryResult {
    const cols = colsCsv.split(',').map((c) => c.trim())
    for (const c of cols) if (!def.columns.has(c)) throw new FakePgError('42703', `column "${c}" does not exist`)
    const out = rows.map((r) => {
      const row: Row = {}
      for (const c of cols) row[c] = r[c] == null ? null : (JSON.parse(JSON.stringify(r[c])) as unknown)
      return row
    })
    return { rows: out, rowCount: out.length }
  }
}
