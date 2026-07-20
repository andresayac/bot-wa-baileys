/**
 * SQLiteStore — persistent store backed by better-sqlite3.
 *
 * Production-ready storage for messages, chats, contacts, flow state,
 * checkpoints and AI conversations. Uses WAL mode for concurrent reads
 * and automatic schema migrations.
 *
 * @example
 * ```ts
 * import { SQLiteStore } from '@bot-wa/bot-wa-baileys'
 *
 * const bot = new Bot({
 *   session: 'my-bot',
 *   store: new SQLiteStore({ file: './data/bot.db' }),
 * })
 * ```
 */

import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import type { proto, WAMessage, WAMessageKey, Chat, Contact } from '@whiskeysockets/baileys'
import type { AIMessage, FlowCheckpoint, IStore } from './IStore.js'
import { messageKey } from './IStore.js'

export interface SQLiteStoreOptions {
  /** Path to the SQLite database file. Default: './bot.db' */
  file?: string
  /** Enable WAL mode for better concurrent read performance. Default: true */
  wal?: boolean
  /** Logger for errors. */
  logger?: { error?: (...args: unknown[]) => void }
}

const SCHEMA_VERSION = 1

export class SQLiteStore implements IStore {
  private db: BetterSqlite3.Database
  private readonly file: string
  private readonly logger?: { error?: (...args: unknown[]) => void }

  constructor(opts: SQLiteStoreOptions = {}) {
    this.file = opts.file ?? './bot.db'
    this.logger = opts.logger

    // better-sqlite3 is a native, CommonJS module and an OPTIONAL peer dependency —
    // require it lazily so users who never touch SQLiteStore don't have to compile it.
    // createRequire keeps the constructor synchronous (unlike dynamic import()).
    let DatabaseCtor: typeof BetterSqlite3
    try {
      DatabaseCtor = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
    } catch {
      throw new Error(
        "SQLiteStore requires the optional peer dependency 'better-sqlite3'. " +
          'Install it with: npm install better-sqlite3 (or pnpm/yarn add).',
      )
    }

    this.db = new DatabaseCtor(this.file)

    // Enable WAL mode for better concurrency
    if (opts.wal !== false) {
      this.db.pragma('journal_mode = WAL')
    }

    // Performance optimizations
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('cache_size = -64000') // 64MB cache
    this.db.pragma('foreign_keys = ON')

    this.migrate()
  }

  private migrate(): void {
    // Ensure the version table exists first (idempotent).
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')

    const row = this.db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined

    const currentVersion = row?.version ?? 0

    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          key_json TEXT NOT NULL,
          message_json TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, timestamp);

        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          chat_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          contact_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS flow_states (
          user_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
          key TEXT PRIMARY KEY,
          checkpoint_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          key TEXT PRIMARY KEY,
          messages_json TEXT NOT NULL
        );
      `)
      this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(1)
    }
  }

  /* Messages -------------------------------------------------------------- */

  async saveMessage(msg: WAMessage): Promise<void> {
    const key = msg.key as WAMessageKey
    const id = messageKey(key)
    const chatId = key.remoteJid ?? ''
    const timestamp = (msg.messageTimestamp as number) ?? Date.now()

    this.db
      .prepare(
        'INSERT OR REPLACE INTO messages (id, chat_id, key_json, message_json, timestamp) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, chatId, JSON.stringify(key), JSON.stringify(msg), timestamp)
  }

  async getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const id = messageKey(key)
    const row = this.db
      .prepare('SELECT message_json FROM messages WHERE id = ?')
      .get(id) as { message_json: string } | undefined

    if (!row) return undefined
    const msg = JSON.parse(row.message_json) as WAMessage
    return msg.message ?? undefined
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<WAMessage[]> {
    const rows = this.db
      .prepare(
        'SELECT message_json FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
      )
      .all(chatId, limit) as Array<{ message_json: string }>

    return rows.map((r) => JSON.parse(r.message_json) as WAMessage).reverse()
  }

  async updateMessage(key: WAMessageKey, patch: Partial<WAMessage>): Promise<WAMessage | undefined> {
    const id = messageKey(key)
    const row = this.db
      .prepare('SELECT message_json FROM messages WHERE id = ?')
      .get(id) as { message_json: string } | undefined

    if (!row) return undefined
    const msg = { ...JSON.parse(row.message_json), ...patch } as WAMessage
    this.db
      .prepare('UPDATE messages SET message_json = ? WHERE id = ?')
      .run(JSON.stringify(msg), id)
    return msg
  }

  async deleteMessage(key: WAMessageKey): Promise<void> {
    const id = messageKey(key)
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: Partial<Chat> & { id: string }): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO chats (id, chat_json) VALUES (?, ?)')
      .run(chat.id, JSON.stringify(chat))
  }

  async getChat(chatId: string): Promise<Chat | undefined> {
    const row = this.db
      .prepare('SELECT chat_json FROM chats WHERE id = ?')
      .get(chatId) as { chat_json: string } | undefined

    if (!row) return undefined
    return JSON.parse(row.chat_json) as Chat
  }

  async listChats(): Promise<Chat[]> {
    const rows = this.db.prepare('SELECT chat_json FROM chats').all() as Array<{ chat_json: string }>
    return rows.map((r) => JSON.parse(r.chat_json) as Chat)
  }

  async deleteChat(chatId: string): Promise<void> {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: Partial<Contact> & { id: string }): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO contacts (id, contact_json) VALUES (?, ?)')
      .run(contact.id, JSON.stringify(contact))
  }

  async getContact(userId: string): Promise<Contact | undefined> {
    const row = this.db
      .prepare('SELECT contact_json FROM contacts WHERE id = ?')
      .get(userId) as { contact_json: string } | undefined

    if (!row) return undefined
    return JSON.parse(row.contact_json) as Contact
  }

  async listContacts(): Promise<Contact[]> {
    const rows = this.db.prepare('SELECT contact_json FROM contacts').all() as Array<{ contact_json: string }>
    return rows.map((r) => JSON.parse(r.contact_json) as Contact)
  }

  /* Flow state ------------------------------------------------------------ */

  async getFlowState(userId: string): Promise<Record<string, unknown> | undefined> {
    const row = this.db
      .prepare('SELECT state_json FROM flow_states WHERE user_id = ?')
      .get(userId) as { state_json: string } | undefined

    if (!row) return undefined
    return JSON.parse(row.state_json) as Record<string, unknown>
  }

  async setFlowState(userId: string, state: Record<string, unknown>): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO flow_states (user_id, state_json) VALUES (?, ?)')
      .run(userId, JSON.stringify(state))
  }

  async clearFlowState(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM flow_states WHERE user_id = ?').run(userId)
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    const row = this.db
      .prepare('SELECT checkpoint_json FROM checkpoints WHERE key = ?')
      .get(key) as { checkpoint_json: string } | undefined

    if (!row) return undefined
    return JSON.parse(row.checkpoint_json) as FlowCheckpoint
  }

  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO checkpoints (key, checkpoint_json) VALUES (?, ?)')
      .run(key, JSON.stringify(cp))
  }

  async clearCheckpoint(key: string): Promise<void> {
    this.db.prepare('DELETE FROM checkpoints WHERE key = ?').run(key)
  }

  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const rows = this.db.prepare('SELECT key, checkpoint_json FROM checkpoints').all() as Array<{
      key: string
      checkpoint_json: string
    }>
    return rows.map((r) => [r.key, JSON.parse(r.checkpoint_json) as FlowCheckpoint])
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const row = this.db
      .prepare('SELECT messages_json FROM conversations WHERE key = ?')
      .get(key) as { messages_json: string } | undefined

    if (!row) return undefined
    return JSON.parse(row.messages_json) as AIMessage[]
  }

  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO conversations (key, messages_json) VALUES (?, ?)')
      .run(key, JSON.stringify(messages))
  }

  async clearConversation(key: string): Promise<void> {
    this.db.prepare('DELETE FROM conversations WHERE key = ?').run(key)
  }

  /* Lifecycle ------------------------------------------------------------- */

  async start(): Promise<void> {
    // Database is already open in constructor
  }

  async stop(): Promise<void> {
    try {
      this.db.close()
    } catch (err) {
      this.logger?.error?.({ err }, 'SQLiteStore failed to close database')
    }
  }
}
