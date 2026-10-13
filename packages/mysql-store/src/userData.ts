/**
 * `ctx.user` storage for {@link MysqlStore} (internal).
 *
 *   `{prefix}user_data` (user_id VARCHAR(255), namespace VARCHAR(128),
 *     `key` VARCHAR(255), value MEDIUMTEXT, expires_at BIGINT NULL,
 *     updated_at BIGINT, PRIMARY KEY (user_id, namespace, `key`),
 *     INDEX (expires_at)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
 *
 * `utf8mb4_bin` makes ids, namespaces and keys compare EXACTLY (the server's
 * default utf8mb4 collations are case- and accent-insensitive, which would
 * merge `Name` and `name`). The value is JSON text in MEDIUMTEXT (16 MiB). The
 * expiry index is declared inline because MySQL has no
 * `CREATE INDEX IF NOT EXISTS`. Expiry is enforced in the WHERE clause of every
 * read and purged physically by `purge()`, which reports mysql2's `affectedRows`.
 */

import type { UserDataEntry, UserId } from '@bot-wa/core'
import type { MysqlQueryResult } from './MysqlStore.js'

type Query = (sql: string, params?: readonly unknown[]) => Promise<MysqlQueryResult>

const COLUMNS = 'user_id, namespace, `key`, value, expires_at, updated_at'
const LIVE = '(expires_at IS NULL OR expires_at > ?)'

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function toEntry(row: Record<string, unknown>): UserDataEntry {
  const entry: UserDataEntry = {
    userId: text(row.user_id),
    namespace: text(row.namespace),
    key: text(row.key),
    value: JSON.parse(text(row.value)) as unknown,
    updatedAt: Number(row.updated_at),
  }
  if (row.expires_at != null) entry.expiresAt = Number(row.expires_at)
  return entry
}

/** mysql2 resolves DML with a ResultSetHeader in the rows slot. */
function affectedRows(result: MysqlQueryResult): number {
  const header = result[0] as unknown as { affectedRows?: unknown } | undefined
  return typeof header?.affectedRows === 'number' ? header.affectedRows : 0
}

export class MysqlUserData {
  constructor(private readonly query: Query, private readonly table: string) {}

  /** Idempotent schema (part of MysqlStore.start). */
  async migrate(): Promise<void> {
    const t = this.table
    await this.query(
      `CREATE TABLE IF NOT EXISTS \`${t}\` (user_id VARCHAR(255) NOT NULL, namespace VARCHAR(128) NOT NULL, ` +
        '`key` VARCHAR(255) NOT NULL, value MEDIUMTEXT NOT NULL, expires_at BIGINT NULL, updated_at BIGINT NOT NULL, ' +
        `PRIMARY KEY (user_id, namespace, \`key\`), INDEX \`${t}_expires_idx\` (expires_at)) ` +
        'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    )
  }

  async get(userId: UserId, namespace: string, key: string, now: number): Promise<UserDataEntry | undefined> {
    const [rows] = await this.query(
      `SELECT ${COLUMNS} FROM \`${this.table}\` WHERE user_id = ? AND namespace = ? AND \`key\` = ? AND ${LIVE}`,
      [userId, namespace, key, now],
    )
    return rows[0] ? toEntry(rows[0]) : undefined
  }

  async set(entry: UserDataEntry): Promise<void> {
    await this.query(
      `INSERT INTO \`${this.table}\` (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ` +
        'ON DUPLICATE KEY UPDATE value = VALUES(value), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)',
      [entry.userId, entry.namespace, entry.key, JSON.stringify(entry.value), entry.expiresAt ?? null, entry.updatedAt],
    )
  }

  async delete(userId: UserId, namespace?: string, key?: string): Promise<void> {
    if (namespace === undefined) {
      await this.query(`DELETE FROM \`${this.table}\` WHERE user_id = ?`, [userId])
    } else if (key === undefined) {
      await this.query(`DELETE FROM \`${this.table}\` WHERE user_id = ? AND namespace = ?`, [userId, namespace])
    } else {
      await this.query(`DELETE FROM \`${this.table}\` WHERE user_id = ? AND namespace = ? AND \`key\` = ?`, [userId, namespace, key])
    }
  }

  async list(userId: UserId, namespace: string | undefined, now: number): Promise<UserDataEntry[]> {
    const [rows] = namespace === undefined
      ? await this.query(`SELECT ${COLUMNS} FROM \`${this.table}\` WHERE user_id = ? AND ${LIVE}`, [userId, now])
      : await this.query(
        `SELECT ${COLUMNS} FROM \`${this.table}\` WHERE user_id = ? AND namespace = ? AND ${LIVE}`,
        [userId, namespace, now],
      )
    return rows.map(toEntry)
  }

  async purge(now: number): Promise<number> {
    return affectedRows(
      await this.query(`DELETE FROM \`${this.table}\` WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now]),
    )
  }
}
