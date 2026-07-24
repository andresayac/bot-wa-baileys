/**
 * MongoStore — persistent {@link IStore} backed by MongoDB (official driver v6).
 *
 * All state lives in six collections (`messages`, `chats`, `contacts`,
 * `checkpoints`, `conversations`, `cursors` — each optionally prefixed) inside
 * one configurable database, so any number of bot replicas can share one
 * MongoDB deployment. `getMessagesByChat(limit)` is served by a compound
 * `{chatId: 1, timestamp: 1}` index: the latest `limit` messages come back
 * ASCENDING by timestamp (same windowing semantics as the redis/sqlite stores).
 *
 * The client is injectable (`opts.client`) so tests — and callers that own a
 * connection pool — never need a live MongoDB. When no client is injected,
 * `start()` creates and connects one, and `stop()` closes it.
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 * import { MongoStore } from '@bot-wa/mongo-store'
 *
 * const store = new MongoStore({ url: 'mongodb://localhost:27017', dbName: 'mybot' })
 * const bot = new Bot({
 *   provider: new BaileysProvider({ session: 'demo' }),
 *   store,
 * })
 * await store.start()
 * ```
 */

import { MongoClient } from 'mongodb'
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

/** The native mongodb v6 client type (accepted through {@link MongoStoreOptions.client}). */
export type NativeMongoClient = MongoClient

/** Structural subset of the driver's cursor used by {@link MongoStore}. */
export interface MongoLikeCursor<T extends { _id: string }> {
  sort(spec: Record<string, 1 | -1>): this
  limit(count: number): this
  skip(count: number): this
  toArray(): Promise<T[]>
}

/**
 * Structural subset of the driver's collection used by {@link MongoStore}.
 * Tests inject an in-memory fake (see tests/fakeMongo.ts); a real `MongoClient`
 * is accepted through {@link MongoStoreOptions.client} (the native generic
 * typings — Filter/UpdateFilter/WithId unions — are too fancy for direct
 * structural assignability, so the store narrows it at the boundary).
 */
export interface MongoLikeCollection<T extends { _id: string }> {
  insertOne(doc: T): Promise<{ insertedId: unknown }>
  updateOne(
    filter: { _id: string },
    update: { $set: Partial<Omit<T, '_id'>> },
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; upsertedCount: number }>
  findOne(filter: { _id: string }): Promise<T | null>
  find(filter?: Record<string, unknown>): MongoLikeCursor<T>
  deleteOne(filter: { _id: string }): Promise<{ deletedCount: number }>
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>
  createIndex(spec: Record<string, 1 | -1>): Promise<string>
}

export interface MongoLikeDb {
  collection<T extends { _id: string }>(name: string): MongoLikeCollection<T>
}

export interface MongoLikeClient {
  db(name?: string): MongoLikeDb
  connect(): Promise<unknown>
  close(force?: boolean): Promise<void>
}

export interface MongoStoreOptions {
  /** MongoDB connection URL. Default: 'mongodb://localhost:27017'. Ignored when `client` is given. */
  url?: string
  /** Database that holds the store's collections. Default: 'botwa'. */
  dbName?: string
  /** Prefix applied to every collection name (e.g. 'bot2_'). Default: ''. */
  collectionPrefix?: string
  /**
   * Inject an existing client (typically already connected) — a real
   * `MongoClient` or any {@link MongoLikeClient} (e.g. an in-memory fake,
   * REQUIRED for hermetic tests). The store then never connects or closes it —
   * the caller owns the lifecycle.
   */
  client?: MongoLikeClient | NativeMongoClient
  /**
   * Max messages retained per chat. When set, `saveMessage` prunes the oldest
   * documents (by timestamp) beyond the cap. Default: undefined = unbounded.
   */
  maxMessagesPerChat?: number
  logger?: { error?: (...args: unknown[]) => void }
}

/* Document shapes ---------------------------------------------------------- *
 *   messages      { _id: messageKey(ref), chatId, timestamp, msg }
 *   chats         { _id: chat.id, ...StoredChat }
 *   contacts      { _id: contact.id, ...StoredContact }
 *   checkpoints   { _id: key, cp }
 *   conversations { _id: key, messages }
 *   cursors       { _id: key, value }
 * -------------------------------------------------------------------------- */

interface MessageDoc {
  _id: string
  chatId: string
  timestamp: number
  msg: StoredMessage
}
type ChatDoc = StoredChat & { _id: string }
type ContactDoc = StoredContact & { _id: string }
interface CheckpointDoc {
  _id: string
  cp: FlowCheckpoint
}
interface ConversationDoc {
  _id: string
  messages: AIMessage[]
}
interface CursorDoc {
  _id: string
  value: string
}

export class MongoStore implements IStore {
  private readonly client: MongoLikeClient
  private readonly ownsClient: boolean
  private readonly dbName: string
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }
  private started = false

  private readonly messages: MongoLikeCollection<MessageDoc>
  private readonly chats: MongoLikeCollection<ChatDoc>
  private readonly contacts: MongoLikeCollection<ContactDoc>
  private readonly checkpoints: MongoLikeCollection<CheckpointDoc>
  private readonly conversations: MongoLikeCollection<ConversationDoc>
  private readonly cursors: MongoLikeCollection<CursorDoc>

  constructor(opts: MongoStoreOptions = {}) {
    this.dbName = opts.dbName ?? 'botwa'
    this.logger = opts.logger
    this.maxMessagesPerChat = opts.maxMessagesPerChat
    this.ownsClient = !opts.client
    const client = opts.client ?? new MongoClient(opts.url ?? 'mongodb://localhost:27017')
    // The driver's generic command signatures aren't directly assignable to the
    // plain structural interfaces; the command subset used here matches at
    // runtime, so narrow at the boundary.
    this.client = client as unknown as MongoLikeClient

    const p = opts.collectionPrefix ?? ''
    const db = this.client.db(this.dbName)
    this.messages = db.collection<MessageDoc>(`${p}messages`)
    this.chats = db.collection<ChatDoc>(`${p}chats`)
    this.contacts = db.collection<ContactDoc>(`${p}contacts`)
    this.checkpoints = db.collection<CheckpointDoc>(`${p}checkpoints`)
    this.conversations = db.collection<ConversationDoc>(`${p}conversations`)
    this.cursors = db.collection<CursorDoc>(`${p}cursors`)
  }

  /* Messages -------------------------------------------------------------- */

  async saveMessage(msg: StoredMessage): Promise<void> {
    await this.messages.updateOne(
      { _id: messageKey(msg.ref) },
      { $set: { chatId: msg.chatId, timestamp: msg.timestamp, msg } },
      { upsert: true },
    )
    await this.trimChat(msg.chatId)
  }

  /** Prune the oldest messages of a chat beyond `maxMessagesPerChat` (no-op when unset). */
  private async trimChat(chatId: string): Promise<void> {
    if (this.maxMessagesPerChat == null) return
    // Newest first, skip the ones we keep — anything left is stale overflow.
    const stale = await this.messages
      .find({ chatId })
      .sort({ timestamp: -1 })
      .skip(this.maxMessagesPerChat)
      .toArray()
    for (const d of stale) await this.messages.deleteOne({ _id: d._id })
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    const doc = await this.messages.findOne({ _id: messageKey(ref) })
    return doc?.msg
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    // Latest `limit` messages, newest first, then flipped to oldest -> newest.
    const docs = await this.messages
      .find({ chatId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray()
    return docs.reverse().map((d) => d.msg)
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.messages.deleteOne({ _id: messageKey(ref) })
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    await this.chats.updateOne({ _id: chat.id }, { $set: chat }, { upsert: true })
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const doc = await this.chats.findOne({ _id: chatId })
    if (!doc) return undefined
    const { _id, ...chat } = doc
    return chat
  }
  async listChats(): Promise<StoredChat[]> {
    const docs = await this.chats.find({}).toArray()
    return docs.map(({ _id, ...chat }) => chat)
  }
  /** Removes the chat document AND purges its message log (consistent with MemoryStore). */
  async deleteChat(chatId: string): Promise<void> {
    await this.messages.deleteMany({ chatId })
    await this.chats.deleteOne({ _id: chatId })
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    await this.contacts.updateOne({ _id: contact.id }, { $set: contact }, { upsert: true })
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const doc = await this.contacts.findOne({ _id: userId })
    if (!doc) return undefined
    const { _id, ...contact } = doc
    return contact
  }
  async listContacts(): Promise<StoredContact[]> {
    const docs = await this.contacts.find({}).toArray()
    return docs.map(({ _id, ...contact }) => contact)
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    return (await this.cursors.findOne({ _id: key }))?.value
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.cursors.updateOne({ _id: key }, { $set: { value } }, { upsert: true })
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    return (await this.checkpoints.findOne({ _id: key }))?.cp
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    await this.checkpoints.updateOne({ _id: key }, { $set: { cp } }, { upsert: true })
  }
  async clearCheckpoint(key: string): Promise<void> {
    await this.checkpoints.deleteOne({ _id: key })
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const docs = await this.checkpoints.find({}).toArray()
    return docs.map((d) => [d._id, d.cp])
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    return (await this.conversations.findOne({ _id: key }))?.messages
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    await this.conversations.updateOne({ _id: key }, { $set: { messages } }, { upsert: true })
  }
  async clearConversation(key: string): Promise<void> {
    await this.conversations.deleteOne({ _id: key })
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    // Injected clients are caller-managed; never connect/close them.
    if (this.ownsClient && !this.started) await this.client.connect()
    // Backs the per-chat time-ordered read in getMessagesByChat.
    await this.messages.createIndex({ chatId: 1, timestamp: 1 })
    this.started = true
  }
  async stop(): Promise<void> {
    if (!this.ownsClient) return
    try {
      await this.client.close()
    } catch (err) {
      this.logger?.error?.({ err }, 'MongoStore failed to close client')
    }
    this.started = false
  }
}
