/**
 * PostgresStore — persistent / distributed {@link IStore} backed by PostgreSQL
 * (node-postgres, `pg`).
 *
 * All state lives in six tables (names optionally namespaced by `tablePrefix`):
 * messages, chats, contacts, checkpoints, conversations and cursors. Documents
 * are stored as **JSONB**; per-chat message logs are ordered by a dedicated
 * `timestamp BIGINT` column, which makes "last N messages" a plain
 * `ORDER BY timestamp DESC LIMIT n` + reverse. Any number of bot replicas can
 * share one PostgreSQL database.
 *
 * The pool is injectable (`opts.pool`) so tests — and callers that own a pool —
 * never need a live PostgreSQL server. When no pool is injected, `start()`
 * creates one from `connectionString`, creates the schema (idempotent
 * `CREATE TABLE IF NOT EXISTS`) and `stop()` ends it.
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 * import { PostgresStore } from '@bot-wa/postgres-store'
 *
 * const store = new PostgresStore({
 *   connectionString: process.env.DATABASE_URL, // default: postgres://localhost:5432/botwa
 *   tablePrefix: 'mybot_',                      // default: ''
 * })
 * await store.start() // creates the pool (unless one was injected) + schema
 *
 * const bot = new Bot({
 *   provider: new BaileysProvider({ session: 'demo' }),
 *   store,
 * })
 * ```
 */

import { Pool } from 'pg'
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

/** The slice of a `pg` `QueryResult` this store consumes. */
export interface PostgresQueryResult {
  rows: unknown[]
  rowCount?: number | null
}

/**
 * Structural subset of the `pg` `Pool` used by {@link PostgresStore}. Tests
 * inject an in-memory fake (see tests/fakePool.ts); a real `Pool` is accepted
 * through {@link PostgresStoreOptions.pool} via {@link NativePostgresPool}.
 * All DB access goes through the single `query(text, values)` call.
 */
export interface PostgresPoolLike {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>
  end(): Promise<void>
}

/** The native node-postgres `Pool` type (the `pg` dependency). */
export type NativePostgresPool = Pool

export interface PostgresStoreOptions {
  /**
   * PostgreSQL connection URL. Default: 'postgres://localhost:5432/botwa'.
   * Ignored when `pool` is given.
   */
  connectionString?: string
  /**
   * Identifier prefix applied to every table name (e.g. 'mybot_' →
   * 'mybot_messages'), so apps/bots can share one database/schema. Default: ''.
   * Must be a plain SQL identifier prefix (letters, digits, underscores).
   */
  tablePrefix?: string
  /**
   * Inject an existing pool — a real `pg` `Pool` or any
   * {@link PostgresPoolLike} (e.g. an in-memory fake, REQUIRED for hermetic
   * tests). The store then never creates or ends it — the caller owns the
   * lifecycle.
   */
  pool?: PostgresPoolLike | NativePostgresPool
  logger?: { error?: (...args: unknown[]) => void }
}

/** tablePrefix is interpolated into SQL identifiers — allow only plain identifiers. */
const TABLE_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export class PostgresStore implements IStore {
  private readonly connectionString: string
  private readonly prefix: string
  private readonly injectedPool?: PostgresPoolLike
  private readonly logger?: { error?: (...args: unknown[]) => void }
  private pool?: PostgresPoolLike
  private started = false

  constructor(opts: PostgresStoreOptions = {}) {
    this.connectionString = opts.connectionString ?? 'postgres://localhost:5432/botwa'
    const prefix = opts.tablePrefix ?? ''
    if (prefix !== '' && !TABLE_PREFIX_RE.test(prefix)) {
      throw new Error(
        `PostgresStore: invalid tablePrefix ${JSON.stringify(prefix)} — use a plain SQL identifier prefix (letters, digits, underscores, e.g. 'mybot_')`,
      )
    }
    this.prefix = prefix
    this.injectedPool = opts.pool as PostgresPoolLike | undefined
    this.pool = this.injectedPool
    this.logger = opts.logger
  }

  /* Schema ------------------------------------------------------------------ *
   *   {prefix}messages      id TEXT PK, chat_id TEXT, timestamp BIGINT, msg JSONB
   *   {prefix}chats         id TEXT PK, data JSONB
   *   {prefix}contacts      id TEXT PK, data JSONB
   *   {prefix}checkpoints   key TEXT PK, cp JSONB
   *   {prefix}conversations key TEXT PK, messages JSONB
   *   {prefix}cursors       key TEXT PK, value TEXT
   * -------------------------------------------------------------------------- */

  private table(name: 'messages' | 'chats' | 'contacts' | 'checkpoints' | 'conversations' | 'cursors'): string {
    return `${this.prefix}${name}`
  }

  private schemaStatements(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table('messages')} (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, timestamp BIGINT NOT NULL, msg JSONB NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${this.table('messages')}_chat_ts_idx ON ${this.table('messages')} (chat_id, timestamp)`,
      `CREATE TABLE IF NOT EXISTS ${this.table('chats')} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.table('contacts')} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.table('checkpoints')} (key TEXT PRIMARY KEY, cp JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.table('conversations')} (key TEXT PRIMARY KEY, messages JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.table('cursors')} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ]
  }

  /** Single funnel for all DB access: parameterized statements only. */
  private async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    const pool = this.pool
    if (!pool) {
      throw new Error('PostgresStore is not started — call start() before using it')
    }
    return (await pool.query(text, values)) as { rows: T[] }
  }

  /**
   * JSONB columns come back already parsed from node-postgres; tolerate raw
   * JSON strings too (some test fakes / text-mode drivers return those).
   */
  private asJson<T>(value: unknown): T {
    return (typeof value === 'string' ? JSON.parse(value) : value) as T
  }

  /* Messages ---------------------------------------------------------------- */

  async saveMessage(msg: StoredMessage): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('messages')} (id, chat_id, timestamp, msg) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET chat_id = EXCLUDED.chat_id, timestamp = EXCLUDED.timestamp, msg = EXCLUDED.msg`,
      [messageKey(msg.ref), msg.chatId, msg.timestamp, JSON.stringify(msg)],
    )
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    const { rows } = await this.query<{ msg: unknown }>(
      `SELECT msg FROM ${this.table('messages')} WHERE id = $1`,
      [messageKey(ref)],
    )
    const row = rows[0]
    return row ? this.asJson<StoredMessage>(row.msg) : undefined
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    // Latest `limit` rows, newest first — then reversed to oldest -> newest.
    const { rows } = await this.query<{ msg: unknown }>(
      `SELECT msg FROM ${this.table('messages')} WHERE chat_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [chatId, limit],
    )
    return rows.map((r) => this.asJson<StoredMessage>(r.msg)).reverse()
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.query(`DELETE FROM ${this.table('messages')} WHERE id = $1`, [messageKey(ref)])
  }

  /* Chats ------------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('chats')} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [chat.id, JSON.stringify(chat)],
    )
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const { rows } = await this.query<{ data: unknown }>(
      `SELECT data FROM ${this.table('chats')} WHERE id = $1`,
      [chatId],
    )
    const row = rows[0]
    return row ? this.asJson<StoredChat>(row.data) : undefined
  }
  async listChats(): Promise<StoredChat[]> {
    const { rows } = await this.query<{ data: unknown }>(`SELECT data FROM ${this.table('chats')}`)
    return rows.map((r) => this.asJson<StoredChat>(r.data))
  }
  async deleteChat(chatId: string): Promise<void> {
    await this.query(`DELETE FROM ${this.table('chats')} WHERE id = $1`, [chatId])
  }

  /* Contacts ---------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('contacts')} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [contact.id, JSON.stringify(contact)],
    )
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const { rows } = await this.query<{ data: unknown }>(
      `SELECT data FROM ${this.table('contacts')} WHERE id = $1`,
      [userId],
    )
    const row = rows[0]
    return row ? this.asJson<StoredContact>(row.data) : undefined
  }
  async listContacts(): Promise<StoredContact[]> {
    const { rows } = await this.query<{ data: unknown }>(`SELECT data FROM ${this.table('contacts')}`)
    return rows.map((r) => this.asJson<StoredContact>(r.data))
  }

  /* Delivery cursor ---------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    const { rows } = await this.query<{ value: string }>(
      `SELECT value FROM ${this.table('cursors')} WHERE key = $1`,
      [key],
    )
    return rows[0]?.value
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('cursors')} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    )
  }

  /* Flow checkpoints ---------------------------------------------------------- */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    const { rows } = await this.query<{ cp: unknown }>(
      `SELECT cp FROM ${this.table('checkpoints')} WHERE key = $1`,
      [key],
    )
    const row = rows[0]
    return row ? this.asJson<FlowCheckpoint>(row.cp) : undefined
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('checkpoints')} (key, cp) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET cp = EXCLUDED.cp`,
      [key, JSON.stringify(cp)],
    )
  }
  async clearCheckpoint(key: string): Promise<void> {
    await this.query(`DELETE FROM ${this.table('checkpoints')} WHERE key = $1`, [key])
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const { rows } = await this.query<{ key: string; cp: unknown }>(
      `SELECT key, cp FROM ${this.table('checkpoints')}`,
    )
    return rows.map((r) => [r.key, this.asJson<FlowCheckpoint>(r.cp)])
  }

  /* AI conversation history ---------------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const { rows } = await this.query<{ messages: unknown }>(
      `SELECT messages FROM ${this.table('conversations')} WHERE key = $1`,
      [key],
    )
    const row = rows[0]
    return row ? this.asJson<AIMessage[]>(row.messages) : undefined
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('conversations')} (key, messages) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET messages = EXCLUDED.messages`,
      [key, JSON.stringify(messages)],
    )
  }
  async clearConversation(key: string): Promise<void> {
    await this.query(`DELETE FROM ${this.table('conversations')} WHERE key = $1`, [key])
  }

  /* Lifecycle ------------------------------------------------------------------- */

  /**
   * Creates the pool (only when none was injected) and the schema. Idempotent:
   * a second call while started is a no-op; `CREATE TABLE IF NOT EXISTS` makes
   * schema creation safe across replicas and restarts.
   */
  async start(): Promise<void> {
    if (this.started) return
    if (!this.pool) this.pool = new Pool({ connectionString: this.connectionString })
    for (const stmt of this.schemaStatements()) await this.pool.query(stmt)
    this.started = true
  }

  /**
   * Ends the pool ONLY when the store created it; injected pools are
   * caller-managed and left open. After stop() an own-pool store can be
   * started again (a fresh pool + idempotent schema pass).
   */
  async stop(): Promise<void> {
    this.started = false
    if (this.injectedPool) return
    const pool = this.pool
    this.pool = undefined
    if (!pool) return
    try {
      await pool.end()
    } catch (err) {
      this.logger?.error?.({ err }, 'PostgresStore failed to end pool')
    }
  }
}
