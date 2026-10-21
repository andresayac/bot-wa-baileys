/**
 * SQLiteDurableKv / SQLiteDurability — core's `DurableKv` and durability backend
 * (`BotConfig.durability`) on SQLite.
 *
 * One table, `durable`, holds every journal (and the product packages' documents):
 * each row is an opaque JSON document with a version and two nullable sort keys
 * (`due_at`, `done_at`). Every write is one SQL statement whose `WHERE` clause carries
 * the expected version, so a compare-and-set is atomic even with several processes on
 * the same database file (SQLite serialises writers; better-sqlite3 waits up to its
 * `timeout` for the lock). Usually obtained from {@link SQLiteStore.durability}, which
 * shares the store's connection; the database's lifecycle stays with whoever opened it.
 *
 * @example
 * ```ts
 * const store = new SQLiteStore({ file: './data/bot.db' })
 * const bot = new Bot({ provider, store, durability: { journal: store.durability() } })
 * ```
 */

import type BetterSqlite3 from 'better-sqlite3'
import { KvDurability, type DurableKv, type DurableKvEntry, type DurableKvIndex, type DurableTable } from '@botmesh/core'
import type { SQLiteDatabaseLike } from './schedules.js'

/** Idempotent schema of the durable-document table and its two partial indexes. */
export const DURABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS durable (
    tbl TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
    due_at INTEGER, done_at INTEGER, doc TEXT NOT NULL,
    PRIMARY KEY (tbl, id)
  );
  CREATE INDEX IF NOT EXISTS durable_due_idx ON durable (tbl, due_at) WHERE due_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS durable_done_idx ON durable (tbl, done_at) WHERE done_at IS NOT NULL;
`

/** Largest INTEGER sort key we ever compare against (stands in for +∞). */
const MAX_KEY = Number.MAX_SAFE_INTEGER

function key(score: number | null): number | null {
  if (score === null) return null
  if (!Number.isFinite(score)) return score > 0 ? MAX_KEY : -MAX_KEY
  return Math.max(-MAX_KEY, Math.min(MAX_KEY, Math.floor(score)))
}

/** {@link DurableKv} over one SQLite table. */
export class SQLiteDurableKv implements DurableKv {
  private readonly stmts: {
    get: BetterSqlite3.Statement
    insert: BetterSqlite3.Statement
    replace: BetterSqlite3.Statement
    remove: BetterSqlite3.Statement
    rangeDue: BetterSqlite3.Statement
    rangeDone: BetterSqlite3.Statement
  }

  /**
   * @param database An open better-sqlite3 `Database`. Typed structurally so the emitted
   *   declarations do not require `@types/better-sqlite3` in consumer projects.
   */
  constructor(database: SQLiteDatabaseLike) {
    const db = database as unknown as BetterSqlite3.Database
    db.exec(DURABLE_SCHEMA)
    this.stmts = {
      get: db.prepare('SELECT doc, version FROM durable WHERE tbl = ? AND id = ?'),
      insert: db.prepare('INSERT OR IGNORE INTO durable (tbl, id, version, due_at, done_at, doc) VALUES (?, ?, 1, ?, ?, ?)'),
      replace: db.prepare(
        'UPDATE durable SET doc = ?, version = version + 1, due_at = ?, done_at = ? WHERE tbl = ? AND id = ? AND version = ? RETURNING version',
      ),
      remove: db.prepare('DELETE FROM durable WHERE tbl = ? AND id = ? AND version = ?'),
      rangeDue: db.prepare('SELECT id FROM durable WHERE tbl = ? AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at, id LIMIT ?'),
      rangeDone: db.prepare('SELECT id FROM durable WHERE tbl = ? AND done_at IS NOT NULL AND done_at <= ? ORDER BY done_at, id LIMIT ?'),
    }
  }

  async get(tbl: DurableTable, id: string): Promise<DurableKvEntry | undefined> {
    const row = this.stmts.get.get(tbl, id) as { doc: string; version: number | bigint } | undefined
    return row ? { value: row.doc, version: String(row.version) } : undefined
  }

  async insert(tbl: DurableTable, id: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    return this.stmts.insert.run(tbl, id, key(index.due), key(index.done), value).changes === 1 ? '1' : undefined
  }

  async replace(tbl: DurableTable, id: string, version: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const expected = Number.parseInt(version, 10)
    if (!Number.isSafeInteger(expected)) return undefined
    const row = this.stmts.replace.get(value, key(index.due), key(index.done), tbl, id, expected) as { version: number | bigint } | undefined
    return row ? String(row.version) : undefined
  }

  async remove(tbl: DurableTable, id: string, version: string): Promise<boolean> {
    const expected = Number.parseInt(version, 10)
    if (!Number.isSafeInteger(expected)) return false
    return this.stmts.remove.run(tbl, id, expected).changes === 1
  }

  async range(tbl: DurableTable, index: keyof DurableKvIndex, max: number, limit: number): Promise<string[]> {
    const count = Math.max(0, Math.floor(limit))
    if (count === 0) return []
    const stmt = index === 'due' ? this.stmts.rangeDue : this.stmts.rangeDone
    return (stmt.all(tbl, key(max), count) as Array<{ id: string }>).map((r) => r.id)
  }
}

/** SQLite {@link DurabilityBackend} (see the module docs). The caller owns the database. */
export class SQLiteDurability extends KvDurability {
  constructor(database: SQLiteDatabaseLike) { super(new SQLiteDurableKv(database)) }
}
