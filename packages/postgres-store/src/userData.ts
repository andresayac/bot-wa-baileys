/**
 * `ctx.user` storage for {@link PostgresStore} (internal).
 *
 *   {prefix}user_data (user_id TEXT, namespace TEXT, key TEXT, value TEXT,
 *                      expires_at BIGINT NULL, updated_at BIGINT,
 *                      PRIMARY KEY (user_id, namespace, key))
 *
 * The value is JSON TEXT (not JSONB) so it round-trips byte-for-byte — JSONB
 * would reorder keys and reject `\u0000` in strings. Expiry is enforced in the
 * WHERE clause of every read and purged physically by `purge()` through the
 * `expires_at` index. node-postgres returns BIGINT as strings, so numeric
 * columns are converted on the way out.
 */

import type { UserDataEntry, UserId } from '@bot-wa/core'

type Query = <T>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>

interface UserDataRow {
  user_id: string
  namespace: string
  key: string
  value: string
  expires_at: string | number | null
  updated_at: string | number
}

const COLUMNS = 'user_id, namespace, key, value, expires_at, updated_at'

function toEntry(row: UserDataRow): UserDataEntry {
  const entry: UserDataEntry = {
    userId: row.user_id,
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value) as unknown,
    updatedAt: Number(row.updated_at),
  }
  if (row.expires_at != null) entry.expiresAt = Number(row.expires_at)
  return entry
}

export class PostgresUserData {
  constructor(private readonly query: Query, private readonly table: string) {}

  /** Idempotent schema (part of PostgresStore.start). */
  schemaStatements(): string[] {
    const t = this.table
    return [
      `CREATE TABLE IF NOT EXISTS ${t} (user_id TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at BIGINT, updated_at BIGINT NOT NULL, PRIMARY KEY (user_id, namespace, key))`,
      `CREATE INDEX IF NOT EXISTS ${t}_expires_idx ON ${t} (expires_at)`,
    ]
  }

  async get(userId: UserId, namespace: string, key: string, now: number): Promise<UserDataEntry | undefined> {
    const { rows } = await this.query<UserDataRow>(
      `SELECT ${COLUMNS} FROM ${this.table} WHERE user_id = $1 AND namespace = $2 AND key = $3 AND (expires_at IS NULL OR expires_at > $4)`,
      [userId, namespace, key, now],
    )
    return rows[0] ? toEntry(rows[0]) : undefined
  }

  async set(entry: UserDataEntry): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, namespace, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
      [entry.userId, entry.namespace, entry.key, JSON.stringify(entry.value), entry.expiresAt ?? null, entry.updatedAt],
    )
  }

  async delete(userId: UserId, namespace?: string, key?: string): Promise<void> {
    if (namespace === undefined) {
      await this.query(`DELETE FROM ${this.table} WHERE user_id = $1`, [userId])
    } else if (key === undefined) {
      await this.query(`DELETE FROM ${this.table} WHERE user_id = $1 AND namespace = $2`, [userId, namespace])
    } else {
      await this.query(`DELETE FROM ${this.table} WHERE user_id = $1 AND namespace = $2 AND key = $3`, [userId, namespace, key])
    }
  }

  async list(userId: UserId, namespace: string | undefined, now: number): Promise<UserDataEntry[]> {
    const { rows } = namespace === undefined
      ? await this.query<UserDataRow>(
        `SELECT ${COLUMNS} FROM ${this.table} WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > $2)`,
        [userId, now],
      )
      : await this.query<UserDataRow>(
        `SELECT ${COLUMNS} FROM ${this.table} WHERE user_id = $1 AND namespace = $2 AND (expires_at IS NULL OR expires_at > $3)`,
        [userId, namespace, now],
      )
    return rows.map(toEntry)
  }

  async purge(now: number): Promise<number> {
    const { rowCount } = await this.query(
      `DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= $1`,
      [now],
    )
    return rowCount ?? 0
  }
}
