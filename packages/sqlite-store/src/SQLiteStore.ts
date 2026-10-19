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
   * persistent DB is often the full archive; opt in to bound growth). Must be a
   * non-negative integer, else the constructor throws a `RangeError`.
   */
  maxMessagesPerChat?: number
  logger?: { error?: (...args: unknown[]) => void }
}

/**
 * Window size for `getMessagesByChat`, with MemoryStore's semantics for any
 * number: non-positive/NaN gives nothing (`0`), a fraction rounds up, Infinity
 * means everything (`-1`, SQLite's "no limit"). Passed through raw, SQLite read
 * a negative LIMIT as "all" and rejected a fraction.
 */
function windowLimit(limit: number): number {
  if (!(limit > 0)) return 0
  return Number.isFinite(limit) ? Math.ceil(limit) : -1
}

/** Prepared statements, compiled once per store instead of on every call. */
interface Statements {
  saveMessage: BetterSqlite3.Statement
  trimChat: BetterSqlite3.Statement
  getMessage: BetterSqlite3.Statement
  messagesByChat: BetterSqlite3.Statement
  deleteMessage: BetterSqlite3.Statement
  deleteChatMessages: BetterSqlite3.Statement
  getChat: BetterSqlite3.Statement
  putChat: BetterSqlite3.Statement
  listChats: BetterSqlite3.Statement
  deleteChat: BetterSqlite3.Statement
  getContact: BetterSqlite3.Statement
  putContact: BetterSqlite3.Statement
  listContacts: BetterSqlite3.Statement
  deleteContact: BetterSqlite3.Statement
  getCursor: BetterSqlite3.Statement
  setCursor: BetterSqlite3.Statement
  getCheckpoint: BetterSqlite3.Statement
  setCheckpoint: BetterSqlite3.Statement
  clearCheckpoint: BetterSqlite3.Statement
  listCheckpoints: BetterSqlite3.Statement
  getConversation: BetterSqlite3.Statement
  setConversation: BetterSqlite3.Statement
  clearConversation: BetterSqlite3.Statement
}

export class SQLiteStore implements IStore {
  private db: BetterSqlite3.Database
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }
  private readonly userData: SqliteUserData
  private readonly stmts: Statements
  private readonly deleteChatTx: (chatId: string) => void
  private readonly mergeChatTx: (chat: StoredChat) => void
  private readonly mergeContactTx: (contact: StoredContact) => void

  constructor(opts: SQLiteStoreOptions = {}) {
    if (opts.maxMessagesPerChat != null && !(Number.isInteger(opts.maxMessagesPerChat) && opts.maxMessagesPerChat >= 0)) {
      throw new RangeError(`SQLiteStore: maxMessagesPerChat must be a non-negative integer, got ${opts.maxMessagesPerChat}`)
    }
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
    const stmts = (this.stmts = this.prepare())
    this.deleteChatTx = this.db.transaction((id: string) => {
      stmts.deleteChatMessages.run(id)
      stmts.deleteChat.run(id)
    })
    // Read-merge-write inside ONE synchronous IMMEDIATE transaction: nothing can
    // interleave in-process (no await between the read and the write) and the
    // write lock is taken up front, so another process sharing the file cannot
    // either. The former `await getChat()` + INSERT let two concurrent partial
    // upserts of one chat drop each other's fields.
    const merge = (get: BetterSqlite3.Statement, put: BetterSqlite3.Statement) => (record: { id: string }): void => {
      const row = get.get(record.id) as { json: string } | undefined
      const existing = row ? (JSON.parse(row.json) as object) : undefined
      put.run(record.id, JSON.stringify({ ...existing, ...record }))
    }
    const mergeChat = this.db.transaction(merge(stmts.getChat, stmts.putChat))
    const mergeContact = this.db.transaction(merge(stmts.getContact, stmts.putContact))
    this.mergeChatTx = (chat) => mergeChat.immediate(chat)
    this.mergeContactTx = (contact) => mergeContact.immediate(contact)
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

  private prepare(): Statements {
    const db = this.db
    return {
      saveMessage: db.prepare(
        'INSERT OR REPLACE INTO messages (id, chat_id, sender_id, timestamp, type, body, from_me, msg_json) VALUES (?,?,?,?,?,?,?,?)',
      ),
      trimChat: db.prepare(
        'DELETE FROM messages WHERE chat_id = ? AND id NOT IN ' +
          '(SELECT id FROM messages WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?)',
      ),
      getMessage: db.prepare('SELECT msg_json FROM messages WHERE id = ?'),
      // Timestamp ties break by id — the order trimChat keeps — so the window is deterministic.
      messagesByChat: db.prepare('SELECT msg_json FROM messages WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?'),
      deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
      deleteChatMessages: db.prepare('DELETE FROM messages WHERE chat_id = ?'),
      getChat: db.prepare('SELECT chat_json AS json FROM chats WHERE id = ?'),
      putChat: db.prepare('INSERT OR REPLACE INTO chats (id, chat_json) VALUES (?, ?)'),
      listChats: db.prepare('SELECT chat_json FROM chats'),
      deleteChat: db.prepare('DELETE FROM chats WHERE id = ?'),
      getContact: db.prepare('SELECT contact_json AS json FROM contacts WHERE id = ?'),
      putContact: db.prepare('INSERT OR REPLACE INTO contacts (id, contact_json) VALUES (?, ?)'),
      listContacts: db.prepare('SELECT contact_json FROM contacts'),
      deleteContact: db.prepare('DELETE FROM contacts WHERE id = ?'),
      getCursor: db.prepare('SELECT value FROM cursors WHERE key = ?'),
      setCursor: db.prepare('INSERT OR REPLACE INTO cursors (key, value) VALUES (?, ?)'),
      getCheckpoint: db.prepare('SELECT checkpoint_json FROM checkpoints WHERE key = ?'),
      setCheckpoint: db.prepare('INSERT OR REPLACE INTO checkpoints (key, checkpoint_json) VALUES (?, ?)'),
      clearCheckpoint: db.prepare('DELETE FROM checkpoints WHERE key = ?'),
      listCheckpoints: db.prepare('SELECT key, checkpoint_json FROM checkpoints'),
      getConversation: db.prepare('SELECT messages_json FROM conversations WHERE key = ?'),
      setConversation: db.prepare('INSERT OR REPLACE INTO conversations (key, messages_json) VALUES (?, ?)'),
      clearConversation: db.prepare('DELETE FROM conversations WHERE key = ?'),
    }
  }

  /* Messages -------------------------------------------------------------- */

  /**
   * Upsert keyed by `messageKey(ref)`. A message without `ref.id` or `chatId`
   * is ignored, like MemoryStore: providers send `''` when they have no stable
   * id, and keying those rows would make them overwrite each other.
   */
  async saveMessage(msg: StoredMessage): Promise<void> {
    if (!msg.ref?.id || !msg.chatId) return
    this.stmts.saveMessage.run(
      messageKey(msg.ref),
      msg.chatId,
      msg.senderId ?? null,
      msg.timestamp,
      msg.type,
      msg.body ?? null,
      msg.fromMe ? 1 : 0,
      JSON.stringify(msg),
    )
    this.trimChat(msg.chatId)
  }

  /** Prune the oldest messages of a chat beyond `maxMessagesPerChat` (no-op when unset). */
  private trimChat(chatId: string): void {
    if (this.maxMessagesPerChat == null) return
    this.stmts.trimChat.run(chatId, chatId, this.maxMessagesPerChat)
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    if (!ref.id || !ref.chatId) return undefined
    const row = this.stmts.getMessage.get(messageKey(ref)) as { msg_json: string } | undefined
    return row ? (JSON.parse(row.msg_json) as StoredMessage) : undefined
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    const n = windowLimit(limit)
    if (n === 0) return []
    const rows = this.stmts.messagesByChat.all(chatId, n) as Array<{ msg_json: string }>
    return rows.map((r) => JSON.parse(r.msg_json) as StoredMessage).reverse()
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    this.stmts.deleteMessage.run(messageKey(ref))
  }

  /* Chats ----------------------------------------------------------------- */

  /**
   * Shallow-merge over any existing record (`{ ...existing, ...chat }`; an own
   * `undefined` field unsets it) in one transaction, so concurrent partial
   * upserts never drop each other's fields.
   */
  async upsertChat(chat: StoredChat): Promise<void> {
    this.mergeChatTx(chat)
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const row = this.stmts.getChat.get(chatId) as { json: string } | undefined
    return row ? (JSON.parse(row.json) as StoredChat) : undefined
  }
  async listChats(): Promise<StoredChat[]> {
    return (this.stmts.listChats.all() as Array<{ chat_json: string }>).map((r) => JSON.parse(r.chat_json) as StoredChat)
  }
  /** Removes the chat record AND purges its message log in one transaction (consistent with MemoryStore). */
  async deleteChat(chatId: string): Promise<void> {
    this.deleteChatTx(chatId)
  }

  /* Contacts -------------------------------------------------------------- */

  /** Shallow-merge upsert, atomic like {@link upsertChat}. */
  async upsertContact(contact: StoredContact): Promise<void> {
    this.mergeContactTx(contact)
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const row = this.stmts.getContact.get(userId) as { json: string } | undefined
    return row ? (JSON.parse(row.json) as StoredContact) : undefined
  }
  async listContacts(): Promise<StoredContact[]> {
    return (this.stmts.listContacts.all() as Array<{ contact_json: string }>).map((r) => JSON.parse(r.contact_json) as StoredContact)
  }

  async deleteContact(userId: string): Promise<void> {
    this.stmts.deleteContact.run(userId)
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    const row = this.stmts.getCursor.get(key) as { value: string } | undefined
    return row?.value
  }
  async setCursor(key: string, value: string): Promise<void> {
    this.stmts.setCursor.run(key, value)
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    const row = this.stmts.getCheckpoint.get(key) as { checkpoint_json: string } | undefined
    return row ? (JSON.parse(row.checkpoint_json) as FlowCheckpoint) : undefined
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    this.stmts.setCheckpoint.run(key, JSON.stringify(cp))
  }
  async clearCheckpoint(key: string): Promise<void> {
    this.stmts.clearCheckpoint.run(key)
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const rows = this.stmts.listCheckpoints.all() as Array<{ key: string; checkpoint_json: string }>
    return rows.map((r) => [r.key, JSON.parse(r.checkpoint_json) as FlowCheckpoint])
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const row = this.stmts.getConversation.get(key) as { messages_json: string } | undefined
    return row ? (JSON.parse(row.messages_json) as AIMessage[]) : undefined
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    this.stmts.setConversation.run(key, JSON.stringify(messages))
  }
  async clearConversation(key: string): Promise<void> {
    this.stmts.clearConversation.run(key)
  }

  /* User data (ctx.user) — table `user_data`, lazy expiry + indexed purge -- */

  async getUserData(userId: UserId, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    return this.userData.get(userId, namespace, key, Date.now())
  }
  /** Upsert one entry; rejects with a `TypeError` when `value` is not JSON-serialisable. */
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
