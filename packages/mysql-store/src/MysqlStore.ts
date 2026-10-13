/**
 * MysqlStore — persistent {@link IStore} backed by MySQL/MariaDB (mysql2).
 *
 * All state lives in six small tables (names configurable via `tablePrefix`,
 * so apps/bots can share one database). Message bodies, chats, contacts,
 * checkpoints and conversations are stored as JSON documents; `timestamp` is
 * a plain BIGINT so `getMessagesByChat(limit)` is an indexed
 * `ORDER BY timestamp DESC LIMIT ?` window, returned oldest→newest.
 *
 * The pool is injectable (`opts.pool`) so tests — and callers that own a
 * connection pool — never need a live MySQL server. When no pool is injected,
 * `start()` creates one (`mysql2/promise`.createPool) and provisions the
 * schema (`CREATE TABLE IF NOT EXISTS`), and `stop()` closes it.
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 * import { MysqlStore } from '@bot-wa/mysql-store'
 *
 * const store = new MysqlStore({ uri: 'mysql://user:pass@localhost:3306/botwa' })
 * const bot = new Bot({
 *   provider: new BaileysProvider({ session: 'demo' }),
 *   store,
 * })
 * await store.start()
 * ```
 */

import { createPool } from 'mysql2/promise'
import type { Pool as NativePool } from 'mysql2/promise'
import type {
  AIMessage,
  FlowCheckpoint,
  IStore,
  MessageRef,
  StoredChat,
  StoredContact,
  StoredMessage,
} from '@bot-wa/core'
import { messageKey } from '@bot-wa/core'

/** The native mysql2/promise pool type produced by `createPool`. */
export type NativeMysqlPool = NativePool

/**
 * Result tuple shape returned by mysql2/promise `query()`: `[rows, fields]`.
 * Rows are plain objects (JSON columns come back already parsed by mysql2,
 * TEXT columns as strings).
 */
export type MysqlQueryResult = [rows: Array<Record<string, unknown>>, fields: unknown]

/**
 * Structural subset of a mysql2/promise pool used by {@link MysqlStore}.
 * Tests inject an in-memory fake (see tests/fakePool.ts); a real pool is
 * accepted through {@link MysqlStoreOptions.pool} via {@link NativeMysqlPool}
 * (the native query typings are a wide generic union, so the store narrows
 * the pool at the boundary).
 */
export interface PoolLike {
  query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult>
  end(): Promise<unknown>
}

export interface MysqlStoreOptions {
  /**
   * MySQL connection URI. Default: 'mysql://localhost:3306/botwa'.
   * Ignored when `pool` is given; the host/port/... options take precedence
   * over `uri` when any of them is set.
   */
  uri?: string
  /** Hostname — set (with `database`) to build a config instead of a URI. */
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  /** Prefix for every table the store creates. Default: ''. */
  tablePrefix?: string
  /**
   * Inject an existing mysql2/promise pool — a real pool or any
   * {@link PoolLike} (e.g. an in-memory fake, REQUIRED for hermetic tests).
   * The store then never creates or closes it — the caller owns the
   * lifecycle. Schema provisioning (`CREATE TABLE IF NOT EXISTS`) still runs
   * on `start()`.
   */
  pool?: PoolLike | NativeMysqlPool
  /**
   * Max messages retained per chat. When set, `saveMessage` prunes the oldest
   * rows (by timestamp) beyond the cap. Default: undefined = unbounded.
   */
  maxMessagesPerChat?: number
  logger?: { error?: (...args: unknown[]) => void }
}

/** JSON column reply from mysql2: parsed object OR raw string, depending on driver/column type. */
function fromJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

/**
 * JSON.stringify for MySQL JSON columns. MySQL rejects unpaired UTF-16
 * surrogates (ER_INVALID_JSON_TEXT "The surrogate pair in string is
 * invalid"), e.g. a body truncated in the middle of an emoji. JSON.stringify
 * emits well-formed pairs raw and ONLY lone surrogates as `\udXXX` escapes, so
 * every such escape is rewritten to U+FFFD — the same value UTF-8 based stores
 * end up with. The `\\\\` alternative consumes escaped backslashes first, so
 * literal text such as "\\ud83d" is never touched. Covers keys and values.
 */
function toJson(value: unknown): string {
  return JSON.stringify(value).replace(/\\\\|\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, (m) => (m === '\\\\' ? m : '\\ufffd'))
}

/** Key columns are VARBINARY (exact, byte-wise ids), which mysql2 returns as Buffers. */
function fromKey(value: unknown): string {
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value)
}

export class MysqlStore implements IStore {
  private pool: PoolLike | null
  private ownsPool: boolean
  private readonly uri?: string
  private readonly config?: { host?: string; port?: number; user?: string; password?: string; database?: string }
  private readonly t: {
    messages: string
    chats: string
    contacts: string
    checkpoints: string
    conversations: string
    cursors: string
  }
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }

  constructor(opts: MysqlStoreOptions = {}) {
    // mysql2's pool typings are a wide generic union; the `query(sql, params)`
    // subset used here matches at runtime, so narrow at the boundary.
    this.pool = (opts.pool ?? null) as PoolLike | null
    this.ownsPool = !opts.pool
    this.maxMessagesPerChat = opts.maxMessagesPerChat
    this.uri = opts.uri
    const { host, port, user, password, database } = opts
    if (host != null || port != null || user != null || password != null || database != null) {
      this.config = { host, port, user, password, database }
    }
    this.logger = opts.logger
    const p = opts.tablePrefix ?? ''
    if (!/^[A-Za-z0-9_]*$/.test(p)) {
      throw new Error(`MysqlStore: invalid tablePrefix ${JSON.stringify(p)} (only [A-Za-z0-9_] allowed)`)
    }
    this.t = {
      messages: `${p}messages`,
      chats: `${p}chats`,
      contacts: `${p}contacts`,
      checkpoints: `${p}checkpoints`,
      conversations: `${p}conversations`,
      cursors: `${p}cursors`,
    }
  }

  /** All DB access funnels through here — SQL stays small, fixed and parameterized. */
  private query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult> {
    if (this.pool == null) {
      throw new Error('MysqlStore: pool is not available — call start() first')
    }
    return this.pool.query(sql, params)
  }

  /* Messages -------------------------------------------------------------- */

  async saveMessage(msg: StoredMessage): Promise<void> {
    await this.query(
      `INSERT INTO \`${this.t.messages}\` (id, chat_id, timestamp, msg) VALUES (?, ?, ?, ?) ` +
        'ON DUPLICATE KEY UPDATE chat_id = VALUES(chat_id), timestamp = VALUES(timestamp), msg = VALUES(msg)',
      [messageKey(msg.ref), msg.chatId, msg.timestamp, toJson(msg)],
    )
    await this.trimChat(msg.chatId)
  }

  /**
   * Prune the oldest messages of a chat beyond `maxMessagesPerChat` (no-op when
   * unset). MySQL forbids referencing the DELETE target in a plain subquery, so
   * the keep-set is wrapped in a derived table.
   */
  private async trimChat(chatId: string): Promise<void> {
    if (this.maxMessagesPerChat == null) return
    const t = this.t.messages
    await this.query(
      `DELETE FROM \`${t}\` WHERE chat_id = ? AND id NOT IN ` +
        `(SELECT id FROM (SELECT id FROM \`${t}\` WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?) keep)`,
      [chatId, chatId, this.maxMessagesPerChat],
    )
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    const [rows] = await this.query(`SELECT msg FROM \`${this.t.messages}\` WHERE id = ?`, [messageKey(ref)])
    return fromJson<StoredMessage>(rows[0]?.msg)
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    const [rows] = await this.query(
      `SELECT msg FROM \`${this.t.messages}\` WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [chatId, limit],
    )
    return rows
      .map((r) => fromJson<StoredMessage>(r.msg))
      .filter((m): m is StoredMessage => m != null)
      .reverse() // oldest -> newest
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.query(`DELETE FROM \`${this.t.messages}\` WHERE id = ?`, [messageKey(ref)])
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    // Shallow-merge over any existing record so a partial upsert keeps prior
    // fields — consistent with MemoryStore/MongoStore.
    const existing = await this.getChat(chat.id)
    const merged = { ...existing, ...chat }
    await this.query(
      `INSERT INTO \`${this.t.chats}\` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [chat.id, toJson(merged)],
    )
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const [rows] = await this.query(`SELECT data FROM \`${this.t.chats}\` WHERE id = ?`, [chatId])
    return fromJson<StoredChat>(rows[0]?.data)
  }
  async listChats(): Promise<StoredChat[]> {
    const [rows] = await this.query(`SELECT data FROM \`${this.t.chats}\``)
    return rows.map((r) => fromJson<StoredChat>(r.data)).filter((c): c is StoredChat => c != null)
  }
  /** Removes the chat record AND purges its message log (consistent with MemoryStore). */
  async deleteChat(chatId: string): Promise<void> {
    await this.query(`DELETE FROM \`${this.t.messages}\` WHERE chat_id = ?`, [chatId])
    await this.query(`DELETE FROM \`${this.t.chats}\` WHERE id = ?`, [chatId])
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    const existing = await this.getContact(contact.id)
    const merged = { ...existing, ...contact }
    await this.query(
      `INSERT INTO \`${this.t.contacts}\` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [contact.id, toJson(merged)],
    )
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const [rows] = await this.query(`SELECT data FROM \`${this.t.contacts}\` WHERE id = ?`, [userId])
    return fromJson<StoredContact>(rows[0]?.data)
  }
  async listContacts(): Promise<StoredContact[]> {
    const [rows] = await this.query(`SELECT data FROM \`${this.t.contacts}\``)
    return rows.map((r) => fromJson<StoredContact>(r.data)).filter((c): c is StoredContact => c != null)
  }

  async deleteContact(userId: string): Promise<void> {
    await this.query(`DELETE FROM \`${this.t.contacts}\` WHERE id = ?`, [userId])
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    const [rows] = await this.query(`SELECT value FROM \`${this.t.cursors}\` WHERE \`key\` = ?`, [key])
    const value = rows[0]?.value
    return value == null ? undefined : String(value)
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO \`${this.t.cursors}\` (\`key\`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [key, value],
    )
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    const [rows] = await this.query(`SELECT cp FROM \`${this.t.checkpoints}\` WHERE \`key\` = ?`, [key])
    return fromJson<FlowCheckpoint>(rows[0]?.cp)
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    await this.query(
      `INSERT INTO \`${this.t.checkpoints}\` (\`key\`, cp) VALUES (?, ?) ON DUPLICATE KEY UPDATE cp = VALUES(cp)`,
      [key, toJson(cp)],
    )
  }
  async clearCheckpoint(key: string): Promise<void> {
    await this.query(`DELETE FROM \`${this.t.checkpoints}\` WHERE \`key\` = ?`, [key])
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const [rows] = await this.query(`SELECT \`key\`, cp FROM \`${this.t.checkpoints}\``)
    return rows
      .map((r) => [fromKey(r.key), fromJson<FlowCheckpoint>(r.cp)] as [string, FlowCheckpoint | undefined])
      .filter((e): e is [string, FlowCheckpoint] => e[1] != null)
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const [rows] = await this.query(`SELECT messages FROM \`${this.t.conversations}\` WHERE \`key\` = ?`, [key])
    return fromJson<AIMessage[]>(rows[0]?.messages)
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    await this.query(
      `INSERT INTO \`${this.t.conversations}\` (\`key\`, messages) VALUES (?, ?) ON DUPLICATE KEY UPDATE messages = VALUES(messages)`,
      [key, toJson(messages)],
    )
  }
  async clearConversation(key: string): Promise<void> {
    await this.query(`DELETE FROM \`${this.t.conversations}\` WHERE \`key\` = ?`, [key])
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.pool == null) {
      const pool = this.config != null ? createPool(this.config) : createPool(this.uri ?? 'mysql://localhost:3306/botwa')
      // Narrow the native pool to the query/end subset used here.
      this.pool = pool as unknown as PoolLike
      this.ownsPool = true
    }
    await this.migrate()
  }

  async stop(): Promise<void> {
    if (!this.ownsPool || this.pool == null) return
    const pool = this.pool
    this.pool = null // further calls fail fast with a clear error
    this.ownsPool = false
    try {
      await pool.end()
    } catch (err) {
      this.logger?.error?.({ err }, 'MysqlStore failed to close pool')
    }
  }

  /**
   * CREATE TABLE IF NOT EXISTS for the six state tables (idempotent).
   *
   * - Id/key columns are `VARBINARY(1024)`: ids are opaque strings and must
   *   compare byte-for-byte. A VARCHAR would inherit the server collation
   *   (utf8mb4_0900_ai_ci on MySQL 8 — case- and accent-insensitive, so 'abc'
   *   and 'ABC' would share one row), and the `_bin` collations are PAD SPACE
   *   ('k' = 'k '). 1024 bytes also fits long provider ids (base64 mids,
   *   composed keys) that overflowed the former VARCHAR(255).
   * - The secondary index `chat_ts (chat_id, timestamp)` serves
   *   getMessagesByChat's window, deleteChat and the maxMessagesPerChat trim.
   * - Explicit InnoDB/utf8mb4 so servers with other defaults (latin1, MyISAM)
   *   still get a working schema.
   *
   * Tables created by an older version keep their columns (IF NOT EXISTS
   * never alters); see the README for the manual upgrade.
   */
  private async migrate(): Promise<void> {
    const opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    await this.query(
      `CREATE TABLE IF NOT EXISTS \`${this.t.messages}\` (id VARBINARY(1024) NOT NULL PRIMARY KEY, ` +
        `chat_id VARBINARY(1024) NOT NULL, timestamp BIGINT, msg JSON, KEY chat_ts (chat_id, timestamp)) ${opts}`,
    )
    await this.query(`CREATE TABLE IF NOT EXISTS \`${this.t.chats}\` (id VARBINARY(1024) NOT NULL PRIMARY KEY, data JSON) ${opts}`)
    await this.query(`CREATE TABLE IF NOT EXISTS \`${this.t.contacts}\` (id VARBINARY(1024) NOT NULL PRIMARY KEY, data JSON) ${opts}`)
    await this.query(`CREATE TABLE IF NOT EXISTS \`${this.t.checkpoints}\` (\`key\` VARBINARY(1024) NOT NULL PRIMARY KEY, cp JSON) ${opts}`)
    await this.query(
      `CREATE TABLE IF NOT EXISTS \`${this.t.conversations}\` (\`key\` VARBINARY(1024) NOT NULL PRIMARY KEY, messages JSON) ${opts}`,
    )
    await this.query(`CREATE TABLE IF NOT EXISTS \`${this.t.cursors}\` (\`key\` VARBINARY(1024) NOT NULL PRIMARY KEY, value TEXT) ${opts}`)
  }
}
