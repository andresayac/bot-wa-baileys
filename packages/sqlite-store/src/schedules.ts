/**
 * SQLiteScheduleStore — the durable scheduler's {@link ScheduleStore} on SQLite.
 *
 * Table `schedules`, one row per durable task. Every mutation runs in a
 * `BEGIN IMMEDIATE` transaction (better-sqlite3 is synchronous), so a claim is an
 * atomic compare-and-set even with several processes on the same database file.
 * Usually obtained from {@link SQLiteStore.schedules}, which shares the store's
 * connection; the database's lifecycle stays with whoever opened it.
 *
 * @example
 * ```ts
 * const store = new SQLiteStore({ file: './data/bot.db' })
 * const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
 * bot.schedule('0 9 * * *', { id: 'daily-report', missed: 'run-once' }, async (run) => { … })
 * ```
 */

import type BetterSqlite3 from 'better-sqlite3'
import {
  applyScheduleComplete,
  isScheduleClaimable,
  type ClaimResult,
  type CompletePatch,
  type ScheduleKind,
  type ScheduleRecord,
  type ScheduleStore,
} from '@bot-wa/core'

/**
 * Idempotent schema of the schedules table, plus `schedule_fences`: the last fencing token
 * of each deleted id, so a new registration of the id never reuses a token.
 */
export const SCHEDULES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL,
    next_run_at INTEGER, last_run_at INTEGER, last_status TEXT,
    fencing_token INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedule_fences (id TEXT PRIMARY KEY, token INTEGER NOT NULL);
`

interface ScheduleRow {
  id: string
  kind: string
  spec: string
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  fencing_token: number
  lease_owner: string | null
  lease_until: number | null
  updated_at: number
}

function fromRow(row: ScheduleRow): ScheduleRecord {
  const rec: ScheduleRecord = {
    id: row.id,
    kind: row.kind as ScheduleKind,
    spec: row.spec,
    nextRunAt: row.next_run_at,
    fencingToken: row.fencing_token,
    updatedAt: row.updated_at,
  }
  if (row.last_run_at !== null) rec.lastRunAt = row.last_run_at
  if (row.last_status === 'ok' || row.last_status === 'error') rec.lastStatus = row.last_status
  if (row.lease_owner !== null) rec.leaseOwner = row.lease_owner
  if (row.lease_until !== null) rec.leaseUntil = row.lease_until
  return rec
}

/** A better-sqlite3 `Database` (structural: only what {@link SQLiteScheduleStore} calls). */
export interface SQLiteDatabaseLike {
  exec(sql: string): unknown
  prepare(sql: string): unknown
  transaction(fn: (...args: never[]) => unknown): unknown
}

export class SQLiteScheduleStore implements ScheduleStore {
  private readonly stmts: {
    get: BetterSqlite3.Statement
    insert: BetterSqlite3.Statement
    respec: BetterSqlite3.Statement
    write: BetterSqlite3.Statement
    renew: BetterSqlite3.Statement
    fence: BetterSqlite3.Statement
    delete: BetterSqlite3.Statement
    list: BetterSqlite3.Statement
  }
  private readonly registerTx: (rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number) => ScheduleRecord
  private readonly claimTx: (id: string, owner: string, now: number, leaseMs: number) => ClaimResult | null
  private readonly completeTx: (id: string, token: number, patch: CompletePatch, now: number) => boolean
  private readonly deleteTx: (id: string) => void

  private readonly db: BetterSqlite3.Database

  /**
   * @param database An open better-sqlite3 `Database`. Typed structurally so the emitted
   *   declarations do not require `@types/better-sqlite3` in consumer projects.
   */
  constructor(database: SQLiteDatabaseLike) {
    const db = database as unknown as BetterSqlite3.Database
    this.db = db
    db.exec(SCHEDULES_SCHEMA)
    this.stmts = {
      get: db.prepare('SELECT * FROM schedules WHERE id = ?'),
      insert: db.prepare(
        `INSERT INTO schedules (id, kind, spec, next_run_at, fencing_token, updated_at)
           VALUES (?, ?, ?, ?, COALESCE((SELECT token FROM schedule_fences WHERE id = ?), 0), ?)`,
      ),
      respec: db.prepare('UPDATE schedules SET kind = ?, spec = ?, next_run_at = ?, updated_at = ? WHERE id = ?'),
      write: db.prepare(
        `UPDATE schedules SET next_run_at = ?, last_run_at = ?, last_status = ?, fencing_token = ?,
           lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
      ),
      renew: db.prepare(
        'UPDATE schedules SET lease_until = ? WHERE id = ? AND fencing_token = ? AND lease_owner IS NOT NULL',
      ),
      fence: db.prepare(
        `INSERT INTO schedule_fences (id, token) SELECT id, fencing_token FROM schedules WHERE id = ?
           ON CONFLICT(id) DO UPDATE SET token = MAX(token, excluded.token)`,
      ),
      delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
      list: db.prepare('SELECT * FROM schedules'),
    }
    const s = this.stmts
    const read = (id: string): ScheduleRecord | null => {
      const row = s.get.get(id) as ScheduleRow | undefined
      return row ? fromRow(row) : null
    }
    const write = (r: ScheduleRecord): void => {
      s.write.run(r.nextRunAt, r.lastRunAt ?? null, r.lastStatus ?? null, r.fencingToken, r.leaseOwner ?? null, r.leaseUntil ?? null, r.updatedAt, r.id)
    }
    this.registerTx = db.transaction((rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number) => {
      const current = read(rec.id)
      if (!current) {
        s.insert.run(rec.id, rec.kind, rec.spec, rec.nextRunAt, rec.id, now)
      } else if (current.kind !== rec.kind || current.spec !== rec.spec) {
        s.respec.run(rec.kind, rec.spec, rec.nextRunAt, now, rec.id)
      }
      return read(rec.id) as ScheduleRecord
    }).immediate
    this.claimTx = db.transaction((id: string, owner: string, now: number, leaseMs: number) => {
      const current = read(id)
      if (!current || !isScheduleClaimable(current, now)) return null
      const claimed: ScheduleRecord = {
        ...current,
        fencingToken: current.fencingToken + 1,
        leaseOwner: owner,
        leaseUntil: now + leaseMs,
        updatedAt: now,
      }
      write(claimed)
      return { record: claimed, fencingToken: claimed.fencingToken }
    }).immediate
    this.completeTx = db.transaction((id: string, token: number, patch: CompletePatch, now: number) => {
      const current = read(id)
      if (!current || current.fencingToken !== token || current.leaseOwner === undefined) return false
      write(applyScheduleComplete(current, patch, now))
      return true
    }).immediate
    this.deleteTx = db.transaction((id: string) => {
      s.fence.run(id)
      s.delete.run(id)
    }).immediate
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const row = this.stmts.get.get(id) as ScheduleRow | undefined
    return row ? fromRow(row) : null
  }

  async register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord> {
    return this.registerTx(rec, now)
  }

  async claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null> {
    return this.claimTx(id, owner, now, leaseMs)
  }

  async renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    return this.stmts.renew.run(leaseUntil, id, fencingToken).changes > 0
  }

  async complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    return this.completeTx(id, fencingToken, patch, now)
  }

  /** Deletes the row, keeping its fencing token in `schedule_fences`. */
  async delete(id: string): Promise<void> {
    this.deleteTx(id)
  }

  async list(): Promise<ScheduleRecord[]> {
    return (this.stmts.list.all() as ScheduleRow[]).map(fromRow)
  }
}
