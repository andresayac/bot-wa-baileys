/**
 * In-memory fake of the `pg` pool for the statements PostgresScheduleStore issues (and
 * nothing else: any other statement is rejected, so a changed statement shape fails the
 * tests). BIGINT values come back as strings, like node-postgres. Each statement runs
 * atomically, as a single PostgreSQL statement does.
 */
import type { PostgresQueryResult } from '../src/PostgresStore.js'
import type { PostgresQueryable } from '../src/schedules.js'

interface Row {
  id: string
  kind: string
  spec: string
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  fencing_token: number
  lease_owner: string | null
  lease_until: number | null
  deleted: boolean
  updated_at: number
}

const str = (v: number | null) => (v === null ? null : String(v))
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export class FakeSchedulePool implements PostgresQueryable {
  readonly tables = new Map<string, Map<string, Row>>()
  readonly statements: string[] = []
  /** Error codes thrown by the next CREATE statements (catalog race simulation). */
  failCreate: string[] = []

  private table(name: string): Map<string, Row> {
    const t = this.tables.get(name)
    if (!t) throw Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' })
    return t
  }

  private out(r: Row): Record<string, unknown> {
    return {
      id: r.id, kind: r.kind, spec: r.spec, next_run_at: str(r.next_run_at), last_run_at: str(r.last_run_at),
      last_status: r.last_status, fencing_token: String(r.fencing_token), lease_owner: r.lease_owner,
      lease_until: str(r.lease_until), updated_at: String(r.updated_at),
    }
  }

  async query(text: string, values: unknown[] = []): Promise<PostgresQueryResult> {
    this.statements.push(text)
    await Promise.resolve()
    let m: RegExpExecArray | null
    if ((m = /^CREATE TABLE IF NOT EXISTS (\w+) \(id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL, next_run_at BIGINT, last_run_at BIGINT, last_status TEXT, fencing_token BIGINT NOT NULL DEFAULT 0, lease_owner TEXT, lease_until BIGINT, deleted BOOLEAN NOT NULL DEFAULT FALSE, updated_at BIGINT NOT NULL\)$/.exec(text))) {
      const code = this.failCreate.shift()
      if (code) throw Object.assign(new Error('catalog race'), { code })
      if (!this.tables.has(m[1])) this.tables.set(m[1], new Map())
      return { rows: [], rowCount: 0 }
    }
    if ((m = /^SELECT id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, updated_at FROM (\w+) WHERE id = \$1 AND NOT deleted$/.exec(text))) {
      const r = this.table(m[1]).get(String(values[0]))
      return r && !r.deleted ? { rows: [this.out(r)], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if ((m = /^SELECT id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, updated_at FROM (\w+) WHERE NOT deleted$/.exec(text))) {
      const rows = [...this.table(m[1]).values()].filter((r) => !r.deleted).map((r) => this.out(r))
      return { rows, rowCount: rows.length }
    }
    if ((m = /^INSERT INTO (\w+) AS s \(id, kind, spec, next_run_at, updated_at\) VALUES \(\$1, \$2, \$3, \$4, \$5\) ON CONFLICT \(id\) DO UPDATE SET kind = EXCLUDED\.kind, spec = EXCLUDED\.spec, next_run_at = EXCLUDED\.next_run_at, updated_at = EXCLUDED\.updated_at, last_run_at = CASE WHEN s\.deleted THEN NULL ELSE s\.last_run_at END, last_status = CASE WHEN s\.deleted THEN NULL ELSE s\.last_status END, lease_owner = CASE WHEN s\.deleted THEN NULL ELSE s\.lease_owner END, lease_until = CASE WHEN s\.deleted THEN NULL ELSE s\.lease_until END, deleted = FALSE WHERE s\.deleted OR s\.kind <> EXCLUDED\.kind OR s\.spec <> EXCLUDED\.spec RETURNING id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, updated_at$/.exec(text))) {
      const t = this.table(m[1])
      const [id, kind, spec, next, now] = [String(values[0]), String(values[1]), String(values[2]), num(values[3]), Number(values[4])]
      const r = t.get(id)
      if (!r) {
        const row: Row = { id, kind, spec, next_run_at: next, last_run_at: null, last_status: null, fencing_token: 0, lease_owner: null, lease_until: null, deleted: false, updated_at: now }
        t.set(id, row)
        return { rows: [this.out(row)], rowCount: 1 }
      }
      if (!(r.deleted || r.kind !== kind || r.spec !== spec)) return { rows: [], rowCount: 0 }
      if (r.deleted) Object.assign(r, { last_run_at: null, last_status: null, lease_owner: null, lease_until: null })
      Object.assign(r, { kind, spec, next_run_at: next, updated_at: now, deleted: false })
      return { rows: [this.out(r)], rowCount: 1 }
    }
    if ((m = /^UPDATE (\w+) SET fencing_token = fencing_token \+ 1, lease_owner = \$2, lease_until = \$3, updated_at = \$4 WHERE id = \$1 AND NOT deleted AND next_run_at IS NOT NULL AND next_run_at <= \$4 AND \(lease_until IS NULL OR lease_until <= \$4\) RETURNING id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, updated_at$/.exec(text))) {
      const r = this.table(m[1]).get(String(values[0]))
      const now = Number(values[3])
      if (!r || r.deleted || r.next_run_at === null || r.next_run_at > now || (r.lease_until !== null && r.lease_until > now)) return { rows: [], rowCount: 0 }
      Object.assign(r, { fencing_token: r.fencing_token + 1, lease_owner: String(values[1]), lease_until: Number(values[2]), updated_at: now })
      return { rows: [this.out(r)], rowCount: 1 }
    }
    if ((m = /^UPDATE (\w+) SET lease_until = \$3 WHERE id = \$1 AND NOT deleted AND fencing_token = \$2 AND lease_owner IS NOT NULL$/.exec(text))) {
      const r = this.table(m[1]).get(String(values[0]))
      if (!r || r.deleted || r.fencing_token !== Number(values[1]) || r.lease_owner === null) return { rows: [], rowCount: 0 }
      r.lease_until = Number(values[2])
      return { rows: [], rowCount: 1 }
    }
    if ((m = /^UPDATE (\w+) SET next_run_at = \$3::bigint, last_run_at = COALESCE\(\$4::bigint, last_run_at\), last_status = COALESCE\(\$5::text, last_status\), lease_owner = NULL, lease_until = NULL, updated_at = \$6 WHERE id = \$1 AND NOT deleted AND fencing_token = \$2 AND lease_owner IS NOT NULL$/.exec(text))) {
      const r = this.table(m[1]).get(String(values[0]))
      if (!r || r.deleted || r.fencing_token !== Number(values[1]) || r.lease_owner === null) return { rows: [], rowCount: 0 }
      Object.assign(r, {
        next_run_at: num(values[2]),
        last_run_at: values[3] === null ? r.last_run_at : Number(values[3]),
        last_status: values[4] === null ? r.last_status : String(values[4]),
        lease_owner: null, lease_until: null, updated_at: Number(values[5]),
      })
      return { rows: [], rowCount: 1 }
    }
    if ((m = /^UPDATE (\w+) SET deleted = TRUE, lease_owner = NULL, lease_until = NULL, updated_at = \$2 WHERE id = \$1 AND NOT deleted$/.exec(text))) {
      const r = this.table(m[1]).get(String(values[0]))
      if (!r || r.deleted) return { rows: [], rowCount: 0 }
      Object.assign(r, { deleted: true, lease_owner: null, lease_until: null, updated_at: Number(values[1]) })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`FakeSchedulePool: unsupported statement: ${text}`)
  }

  /** Seed a raw row (e.g. a fencing token near 2^31). */
  seed(table: string, row: Partial<Row> & { id: string }): void {
    const t = this.table(table)
    t.set(row.id, {
      kind: 'interval', spec: '1000', next_run_at: 0, last_run_at: null, last_status: null, fencing_token: 0,
      lease_owner: null, lease_until: null, deleted: false, updated_at: 0, ...row,
    })
  }
}
