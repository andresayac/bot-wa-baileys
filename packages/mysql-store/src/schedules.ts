/**
 * MysqlScheduleStore — the durable scheduler's {@link ScheduleStore} on MySQL/MariaDB.
 *
 * One InnoDB table, `{prefix}schedules`, one row per durable task id. Ids, specs and lease
 * owners are VARBINARY (byte-exact, case- and trailing-space-sensitive, like MysqlStore's
 * keys). `claimDue` runs `SELECT … FOR UPDATE` + `UPDATE` in a short transaction on a
 * dedicated connection, so it returns the exact record it claimed; `renew`/`complete` are
 * single conditional updates fenced by the token.
 *
 * `delete()` is a soft delete: the row stays as a tombstone (`deleted = 1`, lease cleared)
 * so the id's fencing token is never lost, and a later `register()` revives it as a fresh
 * record that keeps the token. Every other call ignores deleted rows.
 *
 * The pool is borrowed, never closed: usually through {@link MysqlStore.schedules}, which
 * shares the store's pool (start the store first; the bot does it for you).
 *
 * @example
 * ```ts
 * const store = new MysqlStore({ uri: process.env.MYSQL_URL })
 * const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
 * bot.schedule('0 9 * * *', { id: 'daily-report', timeZone: 'Europe/Madrid' }, async (run) => { … })
 * ```
 */

import {
  isScheduleClaimable,
  type ClaimResult,
  type CompletePatch,
  type ScheduleKind,
  type ScheduleRecord,
  type ScheduleStore,
} from '@bot-wa/core'
import type { ConnectionLike, MysqlQueryResult, NativeMysqlPool } from './MysqlStore.js'

/** What {@link MysqlScheduleStore} needs from a pool. */
export interface MysqlScheduleQueryable {
  query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult>
  /** A dedicated connection for the claim transaction (mysql2/promise `pool.getConnection()`). */
  getConnection(): Promise<ConnectionLike>
}

export interface MysqlScheduleStoreOptions {
  /** A mysql2/promise pool (or any {@link MysqlScheduleQueryable}). Never closed by this class. */
  pool: MysqlScheduleQueryable | NativeMysqlPool
  /** Table-name prefix (`[A-Za-z0-9_]*`). Default `''` → table `schedules`. */
  tablePrefix?: string
}

/** Column limits (bytes): checked in `register`/`claimDue` instead of failing in the engine's retry loop. */
const MAX_ID_BYTES = 1024
const MAX_SPEC_BYTES = 2048
const MAX_OWNER_BYTES = 512
const ER_DUP_ENTRY = 1062
const ER_LOCK_DEADLOCK = 1213
const CLAIM_ATTEMPTS = 3
const REGISTER_ATTEMPTS = 3

const errno = (err: unknown): unknown => (typeof err === 'object' && err !== null ? (err as { errno?: unknown }).errno : undefined)

/** BIGINT columns can come back as number, string or bigint depending on mysql2 options. */
export function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v)
  if (v !== null && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v)
}

/** VARBINARY columns come back as Buffers. */
function text(v: unknown): string {
  return v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v)
}

const isNull = (v: unknown) => v === null || v === undefined

interface ScheduleRow {
  id: unknown
  kind: unknown
  spec: unknown
  next_run_at: unknown
  last_run_at: unknown
  last_status: unknown
  fencing_token: unknown
  lease_owner: unknown
  lease_until: unknown
  deleted: unknown
  updated_at: unknown
}

function fromRow(row: ScheduleRow): ScheduleRecord {
  const rec: ScheduleRecord = {
    id: text(row.id),
    kind: text(row.kind) as ScheduleKind,
    spec: text(row.spec),
    nextRunAt: isNull(row.next_run_at) ? null : toNum(row.next_run_at),
    fencingToken: toNum(row.fencing_token),
    updatedAt: toNum(row.updated_at),
  }
  if (!isNull(row.last_run_at)) rec.lastRunAt = toNum(row.last_run_at)
  const status = isNull(row.last_status) ? null : text(row.last_status)
  if (status === 'ok' || status === 'error') rec.lastStatus = status
  if (!isNull(row.lease_owner)) rec.leaseOwner = text(row.lease_owner)
  if (!isNull(row.lease_until)) rec.leaseUntil = toNum(row.lease_until)
  return rec
}

const COLUMNS = 'id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, deleted, updated_at'

function checkBytes(what: string, value: string, max: number): void {
  const bytes = new TextEncoder().encode(value).length
  if (bytes > max) throw new RangeError(`MysqlScheduleStore: ${what} is ${bytes} bytes, the limit is ${max}`)
}

function affected(result: MysqlQueryResult): number {
  return Number((result[0] as unknown as { affectedRows?: number }).affectedRows ?? 0)
}

export class MysqlScheduleStore implements ScheduleStore {
  readonly table: string
  private readonly pool: MysqlScheduleQueryable

  constructor(opts: MysqlScheduleStoreOptions) {
    const prefix = opts.tablePrefix ?? ''
    if (!/^[A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(`MysqlScheduleStore: invalid tablePrefix ${JSON.stringify(prefix)} (only [A-Za-z0-9_] allowed)`)
    }
    const pool = opts.pool as Partial<MysqlScheduleQueryable> | undefined
    if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') {
      throw new TypeError('MysqlScheduleStore: `pool` must be a mysql2/promise pool (query() and getConnection())')
    }
    this.table = `${prefix}schedules`
    this.pool = opts.pool as MysqlScheduleQueryable
  }

  /** The idempotent schema statement. */
  schemaStatements(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS \`${this.table}\` (id VARBINARY(${MAX_ID_BYTES}) NOT NULL PRIMARY KEY, ` +
        `kind VARCHAR(16) NOT NULL, spec VARBINARY(${MAX_SPEC_BYTES}) NOT NULL, next_run_at BIGINT NULL, ` +
        'last_run_at BIGINT NULL, last_status VARCHAR(8) NULL, fencing_token BIGINT NOT NULL DEFAULT 0, ' +
        `lease_owner VARBINARY(${MAX_OWNER_BYTES}) NULL, lease_until BIGINT NULL, deleted TINYINT(1) NOT NULL DEFAULT 0, ` +
        'updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    ]
  }

  /** Create the table (idempotent). */
  async start(): Promise<void> {
    for (const statement of this.schemaStatements()) await this.pool.query(statement)
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const [rows] = await this.pool.query(`SELECT ${COLUMNS} FROM \`${this.table}\` WHERE id = ? AND deleted = 0`, [id])
    return rows[0] ? fromRow(rows[0] as unknown as ScheduleRow) : null
  }

  async register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord> {
    checkBytes('the task id', rec.id, MAX_ID_BYTES)
    checkBytes('the task spec', rec.spec, MAX_SPEC_BYTES)
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(
          `INSERT INTO \`${this.table}\` (id, kind, spec, next_run_at, fencing_token, deleted, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)`,
          [rec.id, rec.kind, rec.spec, rec.nextRunAt, now],
        )
        // A brand-new row: soft delete means an id inserted here was never seen, so token 0.
        return { id: rec.id, kind: rec.kind, spec: rec.spec, nextRunAt: rec.nextRunAt, fencingToken: 0, updatedAt: now }
      } catch (err) {
        if (errno(err) !== ER_DUP_ENTRY) throw err
      }
      // Revive a tombstone (fresh state, token kept) or overwrite a changed kind/spec (lease
      // and token kept). MySQL applies SET assignments left to right, so every IF(deleted, …)
      // must come BEFORE `deleted = 0` (also correct under MariaDB SIMULTANEOUS_ASSIGNMENT).
      await this.pool.query(
        `UPDATE \`${this.table}\` SET last_run_at = IF(deleted, NULL, last_run_at), last_status = IF(deleted, NULL, last_status), ` +
          'lease_owner = IF(deleted, NULL, lease_owner), lease_until = IF(deleted, NULL, lease_until), ' +
          'kind = ?, spec = ?, next_run_at = ?, updated_at = ?, deleted = 0 ' +
          'WHERE id = ? AND (deleted = 1 OR kind <> ? OR spec <> ?)',
        [rec.kind, rec.spec, rec.nextRunAt, now, rec.id, rec.kind, rec.spec],
      )
      const stored = await this.get(rec.id)
      if (stored) return stored
      // Deleted between the statements: register again.
      if (attempt >= REGISTER_ATTEMPTS) throw new Error(`MysqlScheduleStore: register(${JSON.stringify(rec.id)}) kept racing a delete`)
    }
  }

  async claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null> {
    checkBytes('the lease owner', owner, MAX_OWNER_BYTES)
    const conn = await this.pool.getConnection()
    let reusable = true
    try {
      for (let attempt = 1; ; attempt++) {
        let open = false
        try {
          await conn.query('START TRANSACTION')
          open = true
          const [rows] = await conn.query(`SELECT ${COLUMNS} FROM \`${this.table}\` WHERE id = ? FOR UPDATE`, [id])
          const row = rows[0] as unknown as ScheduleRow | undefined
          const current = row && Number(row.deleted) === 0 ? fromRow(row) : undefined
          if (!current || !isScheduleClaimable(current, now)) {
            await conn.query('ROLLBACK')
            open = false
            return null
          }
          const record: ScheduleRecord = {
            ...current,
            fencingToken: current.fencingToken + 1,
            leaseOwner: owner,
            leaseUntil: now + leaseMs,
            updatedAt: now,
          }
          await conn.query(
            `UPDATE \`${this.table}\` SET fencing_token = ?, lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
            [record.fencingToken, owner, record.leaseUntil, now, id],
          )
          await conn.query('COMMIT')
          open = false
          return { record, fencingToken: record.fencingToken }
        } catch (err) {
          if (open) {
            try {
              await conn.query('ROLLBACK')
            } catch {
              reusable = false // never hand a connection with an open transaction back to the pool
            }
          }
          if (reusable && errno(err) === ER_LOCK_DEADLOCK && attempt < CLAIM_ATTEMPTS) continue
          throw err
        }
      }
    } finally {
      if (!reusable && typeof conn.destroy === 'function') conn.destroy()
      else conn.release()
    }
  }

  async renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE \`${this.table}\` SET lease_until = ? WHERE id = ? AND deleted = 0 AND fencing_token = ? AND lease_owner IS NOT NULL`,
      [leaseUntil, id, fencingToken],
    )
    if (affected(result) > 0) return true
    // Without the FOUND_ROWS client flag, affectedRows counts CHANGED rows: renewing with
    // the same value reports 0. Check whether the lease is held with exactly that value.
    const [rows] = await this.pool.query(
      `SELECT 1 AS ok FROM \`${this.table}\` WHERE id = ? AND deleted = 0 AND fencing_token = ? AND lease_owner IS NOT NULL AND lease_until = ?`,
      [id, fencingToken, leaseUntil],
    )
    return rows.length > 0
  }

  async complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    // lease_owner always changes (non-NULL → NULL), so affectedRows is exact with or without FOUND_ROWS.
    const result = await this.pool.query(
      `UPDATE \`${this.table}\` SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at), last_status = COALESCE(?, last_status), ` +
        'lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND deleted = 0 AND fencing_token = ? AND lease_owner IS NOT NULL',
      [patch.nextRunAt, patch.lastRunAt ?? null, patch.lastStatus ?? null, now, id, fencingToken],
    )
    return affected(result) > 0
  }

  async delete(id: string): Promise<void> {
    // Soft delete: the tombstone keeps the fencing token (updated_at is only a purge hint).
    await this.pool.query(
      `UPDATE \`${this.table}\` SET deleted = 1, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND deleted = 0`,
      [Date.now(), id],
    )
  }

  async list(): Promise<ScheduleRecord[]> {
    const [rows] = await this.pool.query(`SELECT ${COLUMNS} FROM \`${this.table}\` WHERE deleted = 0`)
    return rows.map((r) => fromRow(r as unknown as ScheduleRow))
  }
}
