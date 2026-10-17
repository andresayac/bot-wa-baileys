/**
 * SQLiteStore — persistent {@link IStore} backed by better-sqlite3 (WAL).
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 * import { SQLiteStore } from '@bot-wa/sqlite-store'
 *
 * const bot = new Bot({
 *   provider: new BaileysProvider({ session: 'demo' }),
 *   store: new SQLiteStore({ file: './data/bot.db' }),
 * })
 * ```
 */

import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  AIMessage,
  FlowCheckpoint,
  IStore,
  MessageRef,
  StoredChat,
  StoredContact,
  StoredMessage,
  UserDataEntry,
  UserId,
} from '@bot-wa/core'
import { messageKey } from '@bot-wa/core'
import { SqliteUserData } from './userData.js'

export interface SQLiteStoreOptions {
  /** Path to the SQLite database file. Default: './bot.db' */
  file?: string
  /** Enable WAL mode for better concurrent read performance. Default: true */
  wal?: boolean
  /**
   * Max messages retained per chat. When set, `saveMessage` prunes the oldest
   * rows (by timestamp) beyond the cap. Default: undefined = unbounded (a
   * persistent DB is often the full archive; opt in to bound growth).
   */
  maxMessagesPerChat?: number
  logger?: { error?: (...args: unknown[]) => void }
}

export class SQLiteStore implements IStore {
  private db: BetterSqlite3.Database
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }
  private readonly userData: SqliteUserData

  constructor(opts: SQLiteStoreOptions = {}) {
    this.logger = opts.logger
    this.maxMessagesPerChat = opts.maxMessagesPerChat
    let DatabaseCtor: typeof BetterSqlite3
    try {
      DatabaseCtor = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
    } catch {
      throw new Error(
        "SQLiteStore requires the optional peer dependency 'better-sqlite3'. Install it: npm i better-sqlite3",
      )
    }
    this.db = new DatabaseCtor(opts.file ?? './bot.db')
    if (opts.wal !== false) this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
    this.userData = new SqliteUserData(this.db)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT,
        timestamp INTEGER NOT NULL, type TEXT NOT NULL, body TEXT,
        from_me INTEGER, msg_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, timestamp);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, chat_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, contact_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, messages_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  /* Messages -------------------------------------------------------------- */

  async saveMessage(msg: StoredMessage): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO messages (id, chat_id, sender_id, timestamp, type, body, from_me, msg_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(messageKey(msg.ref), msg.chatId, msg.senderId ?? null, msg.timestamp, msg.type, msg.body ?? null, msg.fromMe ? 1 : 0, JSON.stringify(msg))
    this.trimChat(msg.chatId)
  }

  /** Prune the oldest messages of a chat beyond `maxMessagesPerChat` (no-op when unset). */
  private trimChat(chatId: string): void {
    if (this.maxMessagesPerChat == null) return
    this.db
      .prepare(
        'DELETE FROM messages WHERE chat_id = ? AND id NOT IN ' +
          '(SELECT id FROM messages WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?)',
      )
      .run(chatId, chatId, this.maxMessagesPerChat)
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    const row = this.db.prepare('SELECT msg_json FROM messages WHERE id = ?').get(messageKey(ref)) as { msg_json: string } | undefined
    return row ? (JSON.parse(row.msg_json) as StoredMessage) : undefined
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    const rows = this.db.prepare('SELECT msg_json FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?').all(chatId, limit) as Array<{ msg_json: string }>
    return rows.map((r) => JSON.parse(r.msg_json) as StoredMessage).reverse()
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageKey(ref))
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    // Merge over any existing record (shallow) so a partial upsert doesn't wipe
    // previously-set fields — consistent with MemoryStore/MongoStore.
    const existing = await this.getChat(chat.id)
    const merged = { ...existing, ...chat }
    this.db.prepare('INSERT OR REPLACE INTO chats (id, chat_json) VALUES (?, ?)').run(chat.id, JSON.stringify(merged))
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const row = this.db.prepare('SELECT chat_json FROM chats WHERE id = ?').get(chatId) as { chat_json: string } | undefined
    return row ? (JSON.parse(row.chat_json) as StoredChat) : undefined
  }
  async listChats(): Promise<StoredChat[]> {
    return (this.db.prepare('SELECT chat_json FROM chats').all() as Array<{ chat_json: string }>).map((r) => JSON.parse(r.chat_json) as StoredChat)
  }
  /** Removes the chat record AND purges its message log (consistent with MemoryStore). */
  async deleteChat(chatId: string): Promise<void> {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id)
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(id)
    })
    tx(chatId)
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    const existing = await this.getContact(contact.id)
    const merged = { ...existing, ...contact }
    this.db.prepare('INSERT OR REPLACE INTO contacts (id, contact_json) VALUES (?, ?)').run(contact.id, JSON.stringify(merged))
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const row = this.db.prepare('SELECT contact_json FROM contacts WHERE id = ?').get(userId) as { contact_json: string } | undefined
    return row ? (JSON.parse(row.contact_json) as StoredContact) : undefined
  }
  async listContacts(): Promise<StoredContact[]> {
    return (this.db.prepare('SELECT contact_json FROM contacts').all() as Array<{ contact_json: string }>).map((r) => JSON.parse(r.contact_json) as StoredContact)
  }

  async deleteContact(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM contacts WHERE id = ?').run(userId)
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM cursors WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }
  async setCursor(key: string, value: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO cursors (key, value) VALUES (?, ?)').run(key, value)
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    const row = this.db.prepare('SELECT checkpoint_json FROM checkpoints WHERE key = ?').get(key) as { checkpoint_json: string } | undefined
    return row ? (JSON.parse(row.checkpoint_json) as FlowCheckpoint) : undefined
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO checkpoints (key, checkpoint_json) VALUES (?, ?)').run(key, JSON.stringify(cp))
  }
  async clearCheckpoint(key: string): Promise<void> {
    this.db.prepare('DELETE FROM checkpoints WHERE key = ?').run(key)
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const rows = this.db.prepare('SELECT key, checkpoint_json FROM checkpoints').all() as Array<{ key: string; checkpoint_json: string }>
    return rows.map((r) => [r.key, JSON.parse(r.checkpoint_json) as FlowCheckpoint])
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const row = this.db.prepare('SELECT messages_json FROM conversations WHERE key = ?').get(key) as { messages_json: string } | undefined
    return row ? (JSON.parse(row.messages_json) as AIMessage[]) : undefined
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO conversations (key, messages_json) VALUES (?, ?)').run(key, JSON.stringify(messages))
  }
  async clearConversation(key: string): Promise<void> {
    this.db.prepare('DELETE FROM conversations WHERE key = ?').run(key)
  }

  /* User data (ctx.user) — table `user_data`, lazy expiry + indexed purge -- */

  async getUserData(userId: UserId, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    return this.userData.get(userId, namespace, key, Date.now())
  }
  async setUserData(entry: UserDataEntry): Promise<void> {
    this.userData.set(entry)
  }
  async deleteUserData(userId: UserId, namespace?: string, key?: string): Promise<void> {
    this.userData.delete(userId, namespace, key)
  }
  async listUserData(userId: UserId, namespace?: string): Promise<UserDataEntry[]> {
    return this.userData.list(userId, namespace, Date.now())
  }
  /** Delete every expired user-data row (all users); resolves with the count. */
  async purgeExpiredUserData(now: number = Date.now()): Promise<number> {
    return this.userData.purge(now)
  }

  /* Lifecycle ------------------------------------------------------------- */

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    try { this.db.close() } catch (err) { this.logger?.error?.({ err }, 'SQLiteStore failed to close') }
  }
}
