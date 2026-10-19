/**
 * In-memory fake of the mysql2/promise pool for the statements MysqlScheduleStore issues
 * (any other statement throws, so a drifted statement fails the tests).
 *
 * Fidelity points (checked against a live server in schedules.integration.test.ts):
 * - VARBINARY columns (id, spec, lease_owner) compare byte-exact and come back as Buffers;
 *   BIGINTs come back as numbers (or strings with `bigNumberStrings`).
 * - A duplicate INSERT throws ER_DUP_ENTRY (errno 1062).
 * - DML replies carry a ResultSetHeader whose `affectedRows` counts MATCHED rows with the
 *   FOUND_ROWS client flag (mysql2's default) and CHANGED rows without it (`foundRows: false`).
 * - `getConnection()` hands out dedicated connections: `SELECT … FOR UPDATE` takes a row
 *   lock held until COMMIT/ROLLBACK; pool writes to a locked row wait for it. `failNext()`
 *   injects a server error into the next FOR UPDATE (a deadlock rolls the transaction back).
 */
import type { ConnectionLike, MysqlQueryResult } from '../src/MysqlStore.js'
import type { MysqlScheduleQueryable } from '../src/schedules.js'

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
  deleted: number
  updated_at: number
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const header = (affectedRows: number): MysqlQueryResult => [{ affectedRows } as unknown as Array<Record<string, unknown>>, undefined]

export function mysqlError(code: string, errno: number, message: string): Error {
  return Object.assign(new Error(message), { code, errno, sqlMessage: message })
}

export interface FakeSchedulePoolOptions {
  /** mysql2's default FOUND_ROWS flag (affectedRows = matched rows). Default true. */
  foundRows?: boolean
  /** Return BIGINT columns as strings. Default false. */
  bigNumberStrings?: boolean
}

export class FakeSchedulePool implements MysqlScheduleQueryable {
  readonly tables = new Map<string, Map<string, Row>>()
  readonly statements: string[] = []
  /** Connections checked out and not yet released or destroyed. */
  open = 0
  private readonly locks = new Map<string, { holder: FakeConnection; waiters: Array<() => void> }>()
  private readonly failures: Error[] = []
  readonly foundRows: boolean
  private readonly bigNumberStrings: boolean

  constructor(opts: FakeSchedulePoolOptions = {}) {
    this.foundRows = opts.foundRows ?? true
    this.bigNumberStrings = opts.bigNumberStrings ?? false
  }

  /** The next `SELECT … FOR UPDATE` throws `err` (e.g. a deadlock, errno 1213). */
  failNext(err: Error): void {
    this.failures.push(err)
  }

  async getConnection(): Promise<ConnectionLike> {
    this.open++
    return new FakeConnection(this)
  }

  query(sql: string, params: readonly unknown[] = []): Promise<MysqlQueryResult> {
    return this.run(norm(sql), params, undefined)
  }

  /* -------------------------------------------------------------- internals */

  out(r: Row): Record<string, unknown> {
    const big = (v: number | null) => (v === null ? null : this.bigNumberStrings ? String(v) : v)
    return {
      id: Buffer.from(r.id), kind: r.kind, spec: Buffer.from(r.spec), next_run_at: big(r.next_run_at),
      last_run_at: big(r.last_run_at), last_status: r.last_status, fencing_token: big(r.fencing_token),
      lease_owner: r.lease_owner === null ? null : Buffer.from(r.lease_owner), lease_until: big(r.lease_until),
      deleted: r.deleted, updated_at: big(r.updated_at),
    }
  }

  private table(name: string): Map<string, Row> {
    const t = this.tables.get(name)
    if (!t) throw mysqlError('ER_NO_SUCH_TABLE', 1146, `Table '${name}' doesn't exist`)
    return t
  }

  async lock(key: string, conn: FakeConnection): Promise<void> {
    for (;;) {
      const held = this.locks.get(key)
      if (!held || held.holder === conn) {
        this.locks.set(key, held ?? { holder: conn, waiters: [] })
        return
      }
      await new Promise<void>((resolve) => held.waiters.push(resolve))
    }
  }

  unlockAll(conn: FakeConnection): void {
    for (const [key, held] of [...this.locks]) {
      if (held.holder !== conn) continue
      this.locks.delete(key)
      for (const w of held.waiters) w()
    }
  }

  /** A write from outside the holder's transaction waits for the row lock. */
  private async waitFor(key: string, conn: FakeConnection | undefined): Promise<void> {
    for (;;) {
      const held = this.locks.get(key)
      if (!held || held.holder === conn) return
      await new Promise<void>((resolve) => held.waiters.push(resolve))
    }
  }

  async run(sql: string, p: readonly unknown[], conn: FakeConnection | undefined): Promise<MysqlQueryResult> {
    this.statements.push(sql)
    await Promise.resolve()
    let m: RegExpExecArray | null
    const C = 'id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, deleted, updated_at'
    if ((m = /^CREATE TABLE IF NOT EXISTS `(\w+)` \(id VARBINARY\(1024\) NOT NULL PRIMARY KEY, kind VARCHAR\(16\) NOT NULL, spec VARBINARY\(2048\) NOT NULL, next_run_at BIGINT NULL, last_run_at BIGINT NULL, last_status VARCHAR\(8\) NULL, fencing_token BIGINT NOT NULL DEFAULT 0, lease_owner VARBINARY\(512\) NULL, lease_until BIGINT NULL, deleted TINYINT\(1\) NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4$/.exec(sql))) {
      if (!this.tables.has(m[1])) this.tables.set(m[1], new Map())
      return header(0)
    }
    if ((m = new RegExp(`^SELECT ${C} FROM \`(\\w+)\` WHERE id = \\? AND deleted = 0$`).exec(sql))) {
      const r = this.table(m[1]).get(String(p[0]))
      return [r && !r.deleted ? [this.out(r)] : [], undefined]
    }
    if ((m = new RegExp(`^SELECT ${C} FROM \`(\\w+)\` WHERE deleted = 0$`).exec(sql))) {
      return [[...this.table(m[1]).values()].filter((r) => !r.deleted).map((r) => this.out(r)), undefined]
    }
    if ((m = new RegExp(`^SELECT ${C} FROM \`(\\w+)\` WHERE id = \\? FOR UPDATE$`).exec(sql))) {
      if (!conn?.inTransaction) throw new Error('FOR UPDATE outside a transaction')
      const failure = this.failures.shift()
      if (failure) {
        conn.rollback()
        throw failure
      }
      const key = `${m[1]}\u0000${String(p[0])}`
      await this.lock(key, conn)
      const r = this.table(m[1]).get(String(p[0]))
      return [r ? [this.out(r)] : [], undefined]
    }
    if ((m = /^INSERT INTO `(\w+)` \(id, kind, spec, next_run_at, fencing_token, deleted, updated_at\) VALUES \(\?, \?, \?, \?, 0, 0, \?\)$/.exec(sql))) {
      const t = this.table(m[1])
      const id = String(p[0])
      await this.waitFor(`${m[1]}\u0000${id}`, conn)
      if (t.has(id)) throw mysqlError('ER_DUP_ENTRY', 1062, `Duplicate entry '${id}' for key 'PRIMARY'`)
      t.set(id, { id, kind: String(p[1]), spec: String(p[2]), next_run_at: num(p[3]), last_run_at: null, last_status: null, fencing_token: 0, lease_owner: null, lease_until: null, deleted: 0, updated_at: Number(p[4]) })
      return header(1)
    }
    if ((m = /^UPDATE `(\w+)` SET last_run_at = IF\(deleted, NULL, last_run_at\), last_status = IF\(deleted, NULL, last_status\), lease_owner = IF\(deleted, NULL, lease_owner\), lease_until = IF\(deleted, NULL, lease_until\), kind = \?, spec = \?, next_run_at = \?, updated_at = \?, deleted = 0 WHERE id = \? AND \(deleted = 1 OR kind <> \? OR spec <> \?\)$/.exec(sql))) {
      const id = String(p[4])
      await this.waitFor(`${m[1]}\u0000${id}`, conn)
      const r = this.table(m[1]).get(id)
      if (!r || !(r.deleted === 1 || r.kind !== String(p[5]) || r.spec !== String(p[6]))) return header(0)
      if (r.deleted) Object.assign(r, { last_run_at: null, last_status: null, lease_owner: null, lease_until: null })
      Object.assign(r, { kind: String(p[0]), spec: String(p[1]), next_run_at: num(p[2]), updated_at: Number(p[3]), deleted: 0 })
      return header(1)
    }
    if ((m = /^UPDATE `(\w+)` SET fencing_token = \?, lease_owner = \?, lease_until = \?, updated_at = \? WHERE id = \?$/.exec(sql))) {
      const r = this.table(m[1]).get(String(p[4]))
      if (!r) return header(0)
      Object.assign(r, { fencing_token: Number(p[0]), lease_owner: String(p[1]), lease_until: Number(p[2]), updated_at: Number(p[3]) })
      return header(1)
    }
    if ((m = /^UPDATE `(\w+)` SET lease_until = \? WHERE id = \? AND deleted = 0 AND fencing_token = \? AND lease_owner IS NOT NULL$/.exec(sql))) {
      const id = String(p[1])
      await this.waitFor(`${m[1]}\u0000${id}`, conn)
      const r = this.table(m[1]).get(id)
      if (!r || r.deleted || r.fencing_token !== Number(p[2]) || r.lease_owner === null) return header(0)
      const changed = r.lease_until !== Number(p[0])
      r.lease_until = Number(p[0])
      return header(this.foundRows || changed ? 1 : 0)
    }
    if ((m = /^SELECT 1 AS ok FROM `(\w+)` WHERE id = \? AND deleted = 0 AND fencing_token = \? AND lease_owner IS NOT NULL AND lease_until = \?$/.exec(sql))) {
      const r = this.table(m[1]).get(String(p[0]))
      const ok = r && !r.deleted && r.fencing_token === Number(p[1]) && r.lease_owner !== null && r.lease_until === Number(p[2])
      return [ok ? [{ ok: 1 }] : [], undefined]
    }
    if ((m = /^UPDATE `(\w+)` SET next_run_at = \?, last_run_at = COALESCE\(\?, last_run_at\), last_status = COALESCE\(\?, last_status\), lease_owner = NULL, lease_until = NULL, updated_at = \? WHERE id = \? AND deleted = 0 AND fencing_token = \? AND lease_owner IS NOT NULL$/.exec(sql))) {
      const id = String(p[4])
      await this.waitFor(`${m[1]}\u0000${id}`, conn)
      const r = this.table(m[1]).get(id)
      if (!r || r.deleted || r.fencing_token !== Number(p[5]) || r.lease_owner === null) return header(0)
      Object.assign(r, {
        next_run_at: num(p[0]),
        last_run_at: p[1] === null ? r.last_run_at : Number(p[1]),
        last_status: p[2] === null ? r.last_status : String(p[2]),
        lease_owner: null, lease_until: null, updated_at: Number(p[3]),
      })
      return header(1)
    }
    if ((m = /^UPDATE `(\w+)` SET deleted = 1, lease_owner = NULL, lease_until = NULL, updated_at = \? WHERE id = \? AND deleted = 0$/.exec(sql))) {
      const id = String(p[1])
      await this.waitFor(`${m[1]}\u0000${id}`, conn)
      const r = this.table(m[1]).get(id)
      if (!r || r.deleted) return header(0)
      Object.assign(r, { deleted: 1, lease_owner: null, lease_until: null, updated_at: Number(p[0]) })
      return header(1)
    }
    throw new Error(`FakeSchedulePool: unsupported statement: ${sql}`)
  }

  /** Seed a raw row (e.g. a fencing token near 2^31). */
  seed(table: string, row: Partial<Row> & { id: string }): void {
    this.table(table).set(row.id, {
      kind: 'interval', spec: '1000', next_run_at: 0, last_run_at: null, last_status: null, fencing_token: 0,
      lease_owner: null, lease_until: null, deleted: 0, updated_at: 0, ...row,
    })
  }
}

class FakeConnection implements ConnectionLike {
  inTransaction = false
  private done = false

  constructor(private readonly pool: FakeSchedulePool) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<MysqlQueryResult> {
    if (this.done) throw new Error('connection already released')
    const s = norm(sql)
    if (s === 'START TRANSACTION') {
      this.inTransaction = true
      return header(0)
    }
    if (s === 'COMMIT' || s === 'ROLLBACK') {
      this.rollback()
      return header(0)
    }
    return this.pool.run(s, params, this)
  }

  /** End the transaction and drop its locks (writes are applied in place; the store only writes before COMMIT). */
  rollback(): void {
    this.inTransaction = false
    this.pool.unlockAll(this)
  }

  release(): void {
    if (this.done) throw new Error('released twice')
    this.done = true
    this.pool.unlockAll(this)
    this.pool.open--
  }

  destroy(): void {
    this.release()
  }
}
