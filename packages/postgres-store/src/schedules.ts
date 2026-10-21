/**
 * PostgresScheduleStore — the durable scheduler's {@link ScheduleStore} on PostgreSQL.
 *
 * One table, `{prefix}schedules`, one row per durable task id. Every contract method is a
 * SINGLE atomic statement (the store only needs `pool.query()`, no client transactions):
 * `claimDue` is a conditional `UPDATE … RETURNING` (the row lock plus READ COMMITTED's
 * re-check give exactly one winner), and `renew`/`complete` are fenced by the token.
 *
 * `delete()` is a soft delete: the row stays as a tombstone (`deleted = TRUE`, lease
 * cleared) so the id's fencing token is never lost, and a later `register()` revives it
 * as a fresh record that keeps the token. Every other call ignores deleted rows.
 *
 * The pool is borrowed, never ended: usually through {@link PostgresStore.schedules},
 * which shares the store's pool (start the store first; the bot does it for you).
 *
 * @example
 * ```ts
 * const store = new PostgresStore({ connectionString: process.env.DATABASE_URL })
 * const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
 * bot.schedule('0 9 * * *', { id: 'daily-report', timeZone: 'America/Bogota' }, async (run) => { … })
 * ```
 */

import type { ClaimResult, CompletePatch, ScheduleKind, ScheduleRecord, ScheduleStore } from '@botmesh/core'
import type { NativePostgresPool, PostgresQueryResult } from './PostgresStore.js'

/** What {@link PostgresScheduleStore} needs from a pool: parameterized `query()` only. */
export interface PostgresQueryable {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>
}

export interface PostgresScheduleStoreOptions {
  /** A `pg` Pool (or any {@link PostgresQueryable}). Never ended by this class. */
  pool: PostgresQueryable | NativePostgresPool
  /** Table-name prefix (plain SQL identifier prefix). Default `''` → table `schedules`. */
  tablePrefix?: string
}

const TABLE_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const CATALOG_RACE_CODES = new Set(['23505', '42P07', '42710'])
const SCHEMA_ATTEMPTS = 5
/** Bound on register retries when the row is deleted concurrently between its two statements. */
const REGISTER_ATTEMPTS = 3

/** BIGINT columns come back as strings from node-postgres: normalize to number. */
export function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v)
  if (v !== null && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v)
}

interface ScheduleRow {
  id: string
  kind: string
  spec: string
  next_run_at: unknown
  last_run_at: unknown
  last_status: string | null
  fencing_token: unknown
  lease_owner: string | null
  lease_until: unknown
  updated_at: unknown
}

function fromRow(row: ScheduleRow): ScheduleRecord {
  const rec: ScheduleRecord = {
    id: row.id,
    kind: row.kind as ScheduleKind,
    spec: row.spec,
    nextRunAt: row.next_run_at === null || row.next_run_at === undefined ? null : toNum(row.next_run_at),
    fencingToken: toNum(row.fencing_token),
    updatedAt: toNum(row.updated_at),
  }
  if (row.last_run_at !== null && row.last_run_at !== undefined) rec.lastRunAt = toNum(row.last_run_at)
  if (row.last_status === 'ok' || row.last_status === 'error') rec.lastStatus = row.last_status
  if (row.lease_owner !== null && row.lease_owner !== undefined) rec.leaseOwner = row.lease_owner
  if (row.lease_until !== null && row.lease_until !== undefined) rec.leaseUntil = toNum(row.lease_until)
  return rec
}

const COLUMNS = 'id, kind, spec, next_run_at, last_run_at, last_status, fencing_token, lease_owner, lease_until, updated_at'

export class PostgresScheduleStore implements ScheduleStore {
  readonly table: string
  private readonly pool: PostgresQueryable

  constructor(opts: PostgresScheduleStoreOptions) {
    const prefix = opts.tablePrefix ?? ''
    if (prefix !== '' && !TABLE_PREFIX_RE.test(prefix)) {
      throw new Error(`PostgresScheduleStore: invalid tablePrefix ${JSON.stringify(prefix)} — use a plain SQL identifier prefix (letters, digits, underscores)`)
    }
    if (!opts.pool || typeof (opts.pool as { query?: unknown }).query !== 'function') {
      throw new TypeError('PostgresScheduleStore: `pool` must be a pg Pool (or an object with query())')
    }
    this.table = `${prefix}schedules`
    this.pool = opts.pool as PostgresQueryable
  }

  /** The idempotent schema statements. */
  schemaStatements(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, kind TEXT NOT NULL, spec TEXT NOT NULL, ` +
        'next_run_at BIGINT, last_run_at BIGINT, last_status TEXT, fencing_token BIGINT NOT NULL DEFAULT 0, ' +
        'lease_owner TEXT, lease_until BIGINT, deleted BOOLEAN NOT NULL DEFAULT FALSE, updated_at BIGINT NOT NULL)',
    ]
  }

  /** Create the table (idempotent; a catalog race between replicas booting together is retried). */
  async start(): Promise<void> {
    for (const statement of this.schemaStatements()) {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.pool.query(statement)
          break
        } catch (err) {
          const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : ''
          if (attempt >= SCHEMA_ATTEMPTS || !CATALOG_RACE_CODES.has(code)) throw err
        }
      }
    }
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM ${this.table} WHERE id = $1 AND NOT deleted`, [id])
    return rows[0] ? fromRow(rows[0] as ScheduleRow) : null
  }

  async register(rec: Pick<ScheduleRecord, 'id' | 'kind' | 'spec' | 'nextRunAt'>, now: number): Promise<ScheduleRecord> {
    // Insert; or revive a deleted row (fresh state, token kept); or overwrite a changed
    // kind/spec (lease and token kept). An unchanged live row is left alone (no RETURNING
    // row), and read back.
    const upsert =
      `INSERT INTO ${this.table} AS s (id, kind, spec, next_run_at, updated_at) VALUES ($1, $2, $3, $4, $5) ` +
      'ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, spec = EXCLUDED.spec, next_run_at = EXCLUDED.next_run_at, ' +
      'updated_at = EXCLUDED.updated_at, ' +
      'last_run_at = CASE WHEN s.deleted THEN NULL ELSE s.last_run_at END, ' +
      'last_status = CASE WHEN s.deleted THEN NULL ELSE s.last_status END, ' +
      'lease_owner = CASE WHEN s.deleted THEN NULL ELSE s.lease_owner END, ' +
      'lease_until = CASE WHEN s.deleted THEN NULL ELSE s.lease_until END, ' +
      'deleted = FALSE ' +
      `WHERE s.deleted OR s.kind <> EXCLUDED.kind OR s.spec <> EXCLUDED.spec RETURNING ${COLUMNS}`
    for (let attempt = 1; ; attempt++) {
      const { rows } = await this.pool.query(upsert, [rec.id, rec.kind, rec.spec, rec.nextRunAt, now])
      if (rows[0]) return fromRow(rows[0] as ScheduleRow)
      const existing = await this.get(rec.id)
      if (existing) return existing
      // Deleted between the two statements: register again.
      if (attempt >= REGISTER_ATTEMPTS) throw new Error(`PostgresScheduleStore: register(${JSON.stringify(rec.id)}) kept racing a delete`)
    }
  }

  async claimDue(id: string, owner: string, now: number, leaseMs: number): Promise<ClaimResult | null> {
    const { rows } = await this.pool.query(
      `UPDATE ${this.table} SET fencing_token = fencing_token + 1, lease_owner = $2, lease_until = $3, updated_at = $4 ` +
        'WHERE id = $1 AND NOT deleted AND next_run_at IS NOT NULL AND next_run_at <= $4 AND (lease_until IS NULL OR lease_until <= $4) ' +
        `RETURNING ${COLUMNS}`,
      [id, owner, now + leaseMs, now],
    )
    if (!rows[0]) return null
    const record = fromRow(rows[0] as ScheduleRow)
    return { record, fencingToken: record.fencingToken }
  }

  async renew(id: string, fencingToken: number, leaseUntil: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.table} SET lease_until = $3 WHERE id = $1 AND NOT deleted AND fencing_token = $2 AND lease_owner IS NOT NULL`,
      [id, fencingToken, leaseUntil],
    )
    return (res.rowCount ?? 0) > 0
  }

  async complete(id: string, fencingToken: number, patch: CompletePatch, now: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.table} SET next_run_at = $3::bigint, last_run_at = COALESCE($4::bigint, last_run_at), ` +
        'last_status = COALESCE($5::text, last_status), lease_owner = NULL, lease_until = NULL, updated_at = $6 ' +
        'WHERE id = $1 AND NOT deleted AND fencing_token = $2 AND lease_owner IS NOT NULL',
      [id, fencingToken, patch.nextRunAt, patch.lastRunAt ?? null, patch.lastStatus ?? null, now],
    )
    return (res.rowCount ?? 0) > 0
  }

  async delete(id: string): Promise<void> {
    // Soft delete: the tombstone keeps the fencing token (updated_at is only a purge hint).
    await this.pool.query(
      `UPDATE ${this.table} SET deleted = TRUE, lease_owner = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1 AND NOT deleted`,
      [id, Date.now()],
    )
  }

  async list(): Promise<ScheduleRecord[]> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM ${this.table} WHERE NOT deleted`)
    return rows.map((r) => fromRow(r as ScheduleRow))
  }
}
