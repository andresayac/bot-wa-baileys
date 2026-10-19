/**
 * In-memory fake of the `pg` pool for the statements PostgresDurableKv issues (and
 * nothing else — any other statement is rejected). Rows are keyed by (tbl, id); BIGINT
 * values come back as strings, like node-postgres. Each statement runs atomically.
 */
import type { PostgresPoolLike, PostgresQueryResult } from '../src/PostgresStore.js'

interface Row { tbl: string; id: string; version: number; due_at: number | null; done_at: number | null; doc: string }

export class FakeDurablePool implements PostgresPoolLike {
  readonly rows = new Map<string, Row>()
  readonly statements: string[] = []
  ended = false

  async query(text: string, values: unknown[] = []): Promise<PostgresQueryResult> {
    this.statements.push(text)
    const k = (tbl: unknown, id: unknown) => `${String(tbl)}\u0000${String(id)}`
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
    let m: RegExpExecArray | null
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS /.test(text)) return { rows: [], rowCount: 0 }
    if (/^SELECT doc, version FROM \w+ WHERE tbl = \$1 AND id = \$2$/.test(text)) {
      const r = this.rows.get(k(values[0], values[1]))
      return { rows: r ? [{ doc: r.doc, version: String(r.version) }] : [], rowCount: r ? 1 : 0 }
    }
    if (/^INSERT INTO \w+ \(tbl, id, version, due_at, done_at, doc\) VALUES \(\$1, \$2, 1, \$3, \$4, \$5\) ON CONFLICT \(tbl, id\) DO NOTHING$/.test(text)) {
      const key = k(values[0], values[1])
      if (this.rows.has(key)) return { rows: [], rowCount: 0 }
      this.rows.set(key, { tbl: String(values[0]), id: String(values[1]), version: 1, due_at: num(values[2]), done_at: num(values[3]), doc: String(values[4]) })
      return { rows: [], rowCount: 1 }
    }
    if (/^UPDATE \w+ SET doc = \$4, version = version \+ 1, due_at = \$5, done_at = \$6 WHERE tbl = \$1 AND id = \$2 AND version = \$3 RETURNING version$/.test(text)) {
      const r = this.rows.get(k(values[0], values[1]))
      if (!r || r.version !== Number(values[2])) return { rows: [], rowCount: 0 }
      r.doc = String(values[3]); r.version += 1; r.due_at = num(values[4]); r.done_at = num(values[5])
      return { rows: [{ version: String(r.version) }], rowCount: 1 }
    }
    if (/^DELETE FROM \w+ WHERE tbl = \$1 AND id = \$2 AND version = \$3$/.test(text)) {
      const key = k(values[0], values[1])
      const r = this.rows.get(key)
      if (!r || r.version !== Number(values[2])) return { rows: [], rowCount: 0 }
      this.rows.delete(key)
      return { rows: [], rowCount: 1 }
    }
    if ((m = /^SELECT id FROM \w+ WHERE tbl = \$1 AND (due_at|done_at) IS NOT NULL AND \1 <= \$2 ORDER BY \1, id LIMIT \$3$/.exec(text))) {
      const col = m[1] as 'due_at' | 'done_at'
      const hits = [...this.rows.values()]
        .filter((r) => r.tbl === values[0] && r[col] !== null && (r[col] as number) <= Number(values[1]))
        .sort((a, b) => (a[col] as number) - (b[col] as number) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, Number(values[2]))
      return { rows: hits.map((r) => ({ id: r.id })), rowCount: hits.length }
    }
    throw new Error(`FakeDurablePool: unsupported statement: ${text}`)
  }

  async end(): Promise<void> { this.ended = true }
}
