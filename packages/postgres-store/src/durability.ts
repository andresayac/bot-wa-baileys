/**
 * PostgreSQL durability backend for `BotConfig.durability` (durable inbox/outbox).
 *
 * One table, `{prefix}durable`, holds both journals: each row is an opaque JSON document
 * with a version (compare-and-set) and two nullable sort keys (`due_at`, `done_at`).
 * Every state transition is computed by core's journal logic and committed with
 * `UPDATE … WHERE version = $n`, so any number of replicas can share the table: two
 * claimers can never both win a record, and a stale lease holder's completion is
 * rejected by its fencing token.
 *
 * @example
 * ```ts
 * import { Pool } from 'pg'
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * const bot = new Bot({
 *   provider,
 *   store: new PostgresStore({ pool }),
 *   durability: { journal: new PostgresDurability({ pool }), instanceId: process.env.HOSTNAME },
 * })
 * ```
 */

import { Pool } from 'pg'
import { KvDurability, type DurableKv, type DurableKvEntry, type DurableKvIndex, type DurableTable } from '@botmesh/core'
import type { NativePostgresPool, PostgresPoolLike } from './PostgresStore.js'

export interface PostgresDurabilityOptions {
  /** An existing pool (shared with `PostgresStore`, or a fake in tests). The backend never ends it. */
  pool?: PostgresPoolLike | NativePostgresPool
  /** Used to create a pool when `pool` is not given. Default `postgres://localhost:5432/botwa`. */
  connectionString?: string
  /** Table-name prefix (plain SQL identifier prefix). Default `''` → table `durable`. */
  tablePrefix?: string
}

const TABLE_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const CATALOG_RACE_CODES = new Set(['23505', '42P07', '42710'])
/** Largest BIGINT sort key we ever compare against (stands in for +∞). */
const MAX_KEY = Number.MAX_SAFE_INTEGER

function key(score: number | null): number | null {
  if (score === null) return null
  if (!Number.isFinite(score)) return score > 0 ? MAX_KEY : -MAX_KEY
  return Math.max(-MAX_KEY, Math.min(MAX_KEY, Math.floor(score)))
}

/** {@link DurableKv} over one PostgreSQL table. */
export class PostgresDurableKv implements DurableKv {
  private pool?: PostgresPoolLike
  private readonly owned: boolean
  readonly table: string

  constructor(private readonly opts: PostgresDurabilityOptions = {}) {
    const prefix = opts.tablePrefix ?? ''
    if (prefix !== '' && !TABLE_PREFIX_RE.test(prefix)) {
      throw new Error(`PostgresDurability: invalid tablePrefix ${JSON.stringify(prefix)} — use a plain SQL identifier prefix`)
    }
    this.table = `${prefix}durable`
    this.pool = opts.pool as PostgresPoolLike | undefined
    this.owned = !opts.pool
  }

  /** The idempotent schema statements. */
  schemaStatements(): string[] {
    const t = this.table
    return [
      `CREATE TABLE IF NOT EXISTS ${t} (tbl TEXT NOT NULL, id TEXT NOT NULL, version BIGINT NOT NULL, due_at BIGINT, done_at BIGINT, doc TEXT NOT NULL, PRIMARY KEY (tbl, id))`,
      `CREATE INDEX IF NOT EXISTS ${t}_due_idx ON ${t} (tbl, due_at) WHERE due_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ${t}_done_idx ON ${t} (tbl, done_at) WHERE done_at IS NOT NULL`,
    ]
  }

  async start(): Promise<void> {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.opts.connectionString ?? 'postgres://localhost:5432/botwa' }) as unknown as PostgresPoolLike
    }
    for (const statement of this.schemaStatements()) {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.pool.query(statement)
          break
        } catch (error) {
          // Replicas booting at once can lose a catalog race on CREATE … IF NOT EXISTS; the object exists by then.
          const code = String((error as { code?: unknown } | null)?.code)
          if (!CATALOG_RACE_CODES.has(code) || attempt >= 5) throw error
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (this.owned && this.pool) {
      const pool = this.pool
      this.pool = undefined
      await pool.end()
    }
  }

  private q(text: string, values: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> {
    if (!this.pool) throw new Error('PostgresDurability is not started — the bot starts it (or call start())')
    return this.pool.query(text, values)
  }

  async get(tbl: DurableTable, id: string): Promise<DurableKvEntry | undefined> {
    const { rows } = await this.q(`SELECT doc, version FROM ${this.table} WHERE tbl = $1 AND id = $2`, [tbl, id])
    const row = rows[0] as { doc: string; version: string | number } | undefined
    return row ? { value: row.doc, version: String(row.version) } : undefined
  }

  async insert(tbl: DurableTable, id: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const res = await this.q(
      `INSERT INTO ${this.table} (tbl, id, version, due_at, done_at, doc) VALUES ($1, $2, 1, $3, $4, $5) ON CONFLICT (tbl, id) DO NOTHING`,
      [tbl, id, key(index.due), key(index.done), value],
    )
    return res.rowCount === 1 ? '1' : undefined
  }

  async replace(tbl: DurableTable, id: string, version: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const { rows } = await this.q(
      `UPDATE ${this.table} SET doc = $4, version = version + 1, due_at = $5, done_at = $6 WHERE tbl = $1 AND id = $2 AND version = $3 RETURNING version`,
      [tbl, id, version, value, key(index.due), key(index.done)],
    )
    const row = rows[0] as { version: string | number } | undefined
    return row ? String(row.version) : undefined
  }

  async remove(tbl: DurableTable, id: string, version: string): Promise<boolean> {
    const res = await this.q(`DELETE FROM ${this.table} WHERE tbl = $1 AND id = $2 AND version = $3`, [tbl, id, version])
    return res.rowCount === 1
  }

  async range(tbl: DurableTable, index: keyof DurableKvIndex, max: number, limit: number): Promise<string[]> {
    const col = index === 'due' ? 'due_at' : 'done_at'
    const { rows } = await this.q(
      `SELECT id FROM ${this.table} WHERE tbl = $1 AND ${col} IS NOT NULL AND ${col} <= $2 ORDER BY ${col}, id LIMIT $3`,
      [tbl, key(max), Math.max(0, Math.floor(limit))],
    )
    return (rows as Array<{ id: string }>).map((r) => r.id)
  }
}

/** PostgreSQL {@link DurabilityBackend} (see the module docs). */
export class PostgresDurability extends KvDurability {
  constructor(opts: PostgresDurabilityOptions = {}) { super(new PostgresDurableKv(opts)) }
}
