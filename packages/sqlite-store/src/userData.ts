/**
 * `ctx.user` storage for {@link SQLiteStore} (internal).
 *
 * Table `user_data` — one row per (user, namespace, top-level key); the value
 * is JSON text. Expiry is stored in `expires_at` (epoch ms, NULL = never),
 * enforced lazily on read and purged physically by `purge()` (indexed).
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { UserDataEntry, UserId } from '@bot-wa/core'

/** Default rows per DELETE of {@link SqliteUserData.purge}. */
export const DEFAULT_PURGE_BATCH_SIZE = 1000

/** Idempotent schema for the user-data table. */
export const USER_DATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL,
    value_json TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, namespace, key)
  );
  CREATE INDEX IF NOT EXISTS idx_user_data_expires ON user_data (expires_at);
`

interface UserDataRow {
  user_id: string
  namespace: string
  key: string
  value_json: string
  expires_at: number | null
  updated_at: number
}

const LIVE = '(expires_at IS NULL OR expires_at > ?)'
const COLUMNS = 'user_id, namespace, key, value_json, expires_at, updated_at'

function toEntry(row: UserDataRow): UserDataEntry {
  const entry: UserDataEntry = {
    userId: row.user_id,
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    updatedAt: Number(row.updated_at),
  }
  if (row.expires_at != null) entry.expiresAt = Number(row.expires_at)
  return entry
}

export class SqliteUserData {
  private readonly stmts: {
    get: BetterSqlite3.Statement
    upsert: BetterSqlite3.Statement
    deleteKey: BetterSqlite3.Statement
    deleteNamespace: BetterSqlite3.Statement
    deleteUser: BetterSqlite3.Statement
    listUser: BetterSqlite3.Statement
    listNamespace: BetterSqlite3.Statement
    purge: BetterSqlite3.Statement
  }

  constructor(db: BetterSqlite3.Database, private readonly batchSize = DEFAULT_PURGE_BATCH_SIZE) {
    db.exec(USER_DATA_SCHEMA)
    this.stmts = {
      get: db.prepare(`SELECT ${COLUMNS} FROM user_data WHERE user_id = ? AND namespace = ? AND key = ? AND ${LIVE}`),
      upsert: db.prepare(`INSERT OR REPLACE INTO user_data (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`),
      deleteKey: db.prepare('DELETE FROM user_data WHERE user_id = ? AND namespace = ? AND key = ?'),
      deleteNamespace: db.prepare('DELETE FROM user_data WHERE user_id = ? AND namespace = ?'),
      deleteUser: db.prepare('DELETE FROM user_data WHERE user_id = ?'),
      listUser: db.prepare(`SELECT ${COLUMNS} FROM user_data WHERE user_id = ? AND ${LIVE}`),
      listNamespace: db.prepare(`SELECT ${COLUMNS} FROM user_data WHERE user_id = ? AND namespace = ? AND ${LIVE}`),
      // One bounded batch (SQLite has no DELETE ... LIMIT by default): the rowids
      // come from the expiry index, and the expiry is re-checked on delete.
      purge: db.prepare(
        'DELETE FROM user_data WHERE rowid IN ' +
          '(SELECT rowid FROM user_data WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?)',
      ),
    }
  }

  get(userId: UserId, namespace: string, key: string, now: number): UserDataEntry | undefined {
    const row = this.stmts.get.get(userId, namespace, key, now) as UserDataRow | undefined
    return row ? toEntry(row) : undefined
  }

  set(entry: UserDataEntry): void {
    const json = JSON.stringify(entry.value) as string | undefined
    if (json === undefined) throw new TypeError('user data value must be JSON-serialisable')
    this.stmts.upsert.run(
      entry.userId,
      entry.namespace,
      entry.key,
      json,
      entry.expiresAt ?? null,
      entry.updatedAt,
    )
  }

  delete(userId: UserId, namespace?: string, key?: string): void {
    if (namespace === undefined) this.stmts.deleteUser.run(userId)
    else if (key === undefined) this.stmts.deleteNamespace.run(userId, namespace)
    else this.stmts.deleteKey.run(userId, namespace, key)
  }

  list(userId: UserId, namespace: string | undefined, now: number): UserDataEntry[] {
    const rows = (namespace === undefined
      ? this.stmts.listUser.all(userId, now)
      : this.stmts.listNamespace.all(userId, namespace, now)) as UserDataRow[]
    return rows.map(toEntry)
  }

  /**
   * Delete expired rows `batchSize` at a time until a batch comes back short.
   * Each batch is its own short write transaction and the loop yields to the
   * event loop in between, so neither other connections nor the bot's own
   * handlers wait for one huge DELETE.
   */
  async purge(now: number): Promise<number> {
    let total = 0
    for (;;) {
      const removed = this.stmts.purge.run(now, this.batchSize).changes
      total += removed
      if (removed < this.batchSize) return total
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}
