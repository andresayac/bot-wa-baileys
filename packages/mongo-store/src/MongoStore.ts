/**
 * MongoStore — persistent {@link IStore} backed by MongoDB (official driver v6).
 *
 * All state lives in seven collections (`messages`, `chats`, `contacts`,
 * `checkpoints`, `conversations`, `cursors`, `user_data` — each optionally prefixed) inside
 * one configurable database, so any number of bot replicas can share one
 * MongoDB deployment. `getMessagesByChat(limit)` is served by a compound
 * `{chatId: 1, timestamp: 1, _id: 1}` index: the latest `limit` messages come
 * back ASCENDING by timestamp, ties broken by message key (`_id`) — the same
 * order the SQL stores use, so the window and the `maxMessagesPerChat` trim
 * agree on which of several same-millisecond messages are the newest.
 *
 * The client is injectable (`opts.client`) so tests — and callers that own a
 * connection pool — never need a live MongoDB. When no client is injected,
 * `start()` creates and connects one, and `stop()` closes it.
 *
 * BSON vs. the IStore contract (MemoryStore is the reference): writes drop
 * `undefined` values instead of persisting BSON `null` (top-level `undefined`
 * in `upsertChat`/`upsertContact` clears the field, like an object spread),
 * and reads promote BSON `Binary` back to Node `Buffer`s, so no driver type
 * leaks out of the store. Documents are capped at MongoDB's 16 MB BSON limit.
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
  UserDataEntry,
  UserId,
} from '@bot-wa/core'
import { legacyMessageKey, messageKey } from '@bot-wa/core'
import { MongoScheduleStore } from './schedules.js'
import { MongoUserData, type UserDataDoc } from './userData.js'

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
  /**
   * `$unset` lists top-level fields to remove (value `''`). `ignoreUndefined`
   * asks the driver to drop `undefined` values instead of storing BSON null.
   */
  updateOne(
    filter: { _id: string },
    update: { $set: Partial<Omit<T, '_id'>>; $unset?: Record<string, ''> },
    options?: { upsert?: boolean; ignoreUndefined?: boolean },
  ): Promise<{ matchedCount: number; upsertedCount: number }>
  /** `promoteBuffers` asks the driver to return BSON Binary as Node Buffers. */
  findOne(filter: { _id: string }, options?: { promoteBuffers?: boolean }): Promise<T | null>
  /** `projection` (e.g. `{ _id: 1 }`) limits the returned fields; the documents are then partial. */
  find(
    filter?: Record<string, unknown>,
    options?: { promoteBuffers?: boolean; projection?: Record<string, 0 | 1> },
  ): MongoLikeCursor<T>
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
   * Must be a non-negative integer, else the constructor throws a `RangeError`.
   */
  maxMessagesPerChat?: number
  /**
   * Documents deleted per `deleteMany` by `purgeExpiredUserData` (default
   * 1000). The purge loops until no expired document is left, so a huge
   * backlog is removed in short operations instead of one long delete. Must be
   * a positive integer, else the constructor throws a `RangeError`.
   */
  purgeBatchSize?: number
  logger?: { error?: (...args: unknown[]) => void }
}

/* Document shapes ---------------------------------------------------------- *
 *   messages      { _id: messageKey(ref), chatId, timestamp, msg }
 *                 (documents written before keys were escaped use legacyMessageKey(ref))
 *   chats         { _id: chat.id, ...StoredChat }
 *   contacts      { _id: contact.id, ...StoredContact }
 *   checkpoints   { _id: key, cp }
 *   conversations { _id: key, messages }
 *   cursors       { _id: key, value }
 *   user_data     { _id: [userId,namespace,key] JSON, userId, namespace, key,
 *                   value (JSON text), expiresAt | null, updatedAt }  — ctx.user
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

/**
 * Write options. By default the driver serializes `undefined` as BSON `null`,
 * which would surface as `null` in fields typed `T | undefined` (e.g. a
 * StoredMessage saved with `body: undefined`). Dropping it matches the JSON
 * semantics of the other stores.
 */
const UPSERT = { upsert: true, ignoreUndefined: true } as const
/** Read options: return BSON Binary as Node Buffers, not the driver's `Binary` class. */
const READ = { promoteBuffers: true } as const

/**
 * Filter for the document that holds the message `ref` names. A legacy
 * (unescaped) key can be another message's escaped key — legacy 'c:%3A' of
 * ('c', '%3A') is the key of ('c', ':') — so writes through one check it.
 */
function ownedBy(ref: MessageRef): Record<string, unknown> {
  return { 'msg.ref.id': ref.id, 'msg.ref.chatId': ref.chatId }
}

/**
 * Max ids per trim `deleteMany`. One `$in` with the whole overflow of a long
 * history (cap turned on or lowered later) overflows BSON's 16 MiB command
 * limit — ~400k message keys already do — so the delete goes in chunks.
 * @internal
 */
export const TRIM_DELETE_BATCH = 10_000

/**
 * Newest-first order of a chat's log: timestamp, then message key, so equal
 * timestamps never make the window or the trim depend on insertion order.
 */
const NEWEST_FIRST = { timestamp: -1, _id: -1 } as const

/** Largest `limit` sent to the server (int32); a larger window simply reads without a limit. */
const MAX_LIMIT = 2_147_483_647

/**
 * Shallow-merge update with object-spread semantics (`{ ...existing, ...patch }`,
 * as in MemoryStore): defined fields are `$set`; fields explicitly present as
 * `undefined` are `$unset` (cleared) rather than stored as BSON null.
 */
function shallowMerge<T extends object>(patch: T): { $set: Partial<T>; $unset?: Record<string, ''> } {
  const $set: Record<string, unknown> = {}
  const $unset: Record<string, ''> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) $unset[key] = ''
    else $set[key] = value
  }
  const update: { $set: Partial<T>; $unset?: Record<string, ''> } = { $set: $set as Partial<T> }
  if (Object.keys($unset).length > 0) update.$unset = $unset
  return update
}

export class MongoStore implements IStore {
  private readonly client: MongoLikeClient
  private readonly ownsClient: boolean
  private readonly dbName: string
  private readonly collectionPrefix: string
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }
  private started = false

  private readonly messages: MongoLikeCollection<MessageDoc>
  private readonly chats: MongoLikeCollection<ChatDoc>
  private readonly contacts: MongoLikeCollection<ContactDoc>
  private readonly checkpoints: MongoLikeCollection<CheckpointDoc>
  private readonly conversations: MongoLikeCollection<ConversationDoc>
  private readonly cursors: MongoLikeCollection<CursorDoc>
  private readonly userData: MongoUserData

  constructor(opts: MongoStoreOptions = {}) {
    if (opts.maxMessagesPerChat != null && !(Number.isInteger(opts.maxMessagesPerChat) && opts.maxMessagesPerChat >= 0)) {
      throw new RangeError(`MongoStore: maxMessagesPerChat must be a non-negative integer, got ${opts.maxMessagesPerChat}`)
    }
    if (opts.purgeBatchSize != null && !(Number.isInteger(opts.purgeBatchSize) && opts.purgeBatchSize > 0)) {
      throw new RangeError(`MongoStore: purgeBatchSize must be a positive integer, got ${opts.purgeBatchSize}`)
    }
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
    this.collectionPrefix = p
    const db = this.client.db(this.dbName)
    this.messages = db.collection<MessageDoc>(`${p}messages`)
    this.chats = db.collection<ChatDoc>(`${p}chats`)
    this.contacts = db.collection<ContactDoc>(`${p}contacts`)
    this.checkpoints = db.collection<CheckpointDoc>(`${p}checkpoints`)
    this.conversations = db.collection<ConversationDoc>(`${p}conversations`)
    this.cursors = db.collection<CursorDoc>(`${p}cursors`)
    this.userData = new MongoUserData(db.collection<UserDataDoc>(`${p}user_data`), opts.purgeBatchSize)
  }

  /* Messages -------------------------------------------------------------- */

  /**
   * Upsert keyed by `messageKey(ref)`. A message without `ref.id` or `chatId`
   * is ignored, like MemoryStore: providers send `''` when they have no stable
   * id, and keying those would make them overwrite each other.
   */
  async saveMessage(msg: StoredMessage): Promise<void> {
    if (!msg.ref?.id || !msg.chatId) return
    const key = messageKey(msg.ref)
    await this.messages.updateOne(
      { _id: key },
      { $set: { chatId: msg.chatId, timestamp: msg.timestamp, msg } },
      UPSERT,
    )
    // Drop the copy an older version wrote under the legacy key (else the
    // message would be listed twice). No-op for ids without ':' or '%'.
    const legacy = legacyMessageKey(msg.ref)
    if (legacy !== key) await this.messages.deleteMany({ _id: legacy, chatId: msg.chatId, ...ownedBy(msg.ref) })
    await this.trimChat(msg.chatId)
  }

  /** Prune the oldest messages of a chat beyond `maxMessagesPerChat` (no-op when unset). */
  private async trimChat(chatId: string): Promise<void> {
    if (this.maxMessagesPerChat == null) return
    // Newest first, skip the ones we keep — anything left is stale overflow.
    // Only the ids travel back; the overflow goes in as few deleteMany as fit.
    const stale = await this.messages
      .find({ chatId }, { projection: { _id: 1 } })
      .sort(NEWEST_FIRST)
      .skip(this.maxMessagesPerChat)
      .toArray()
    // Chunked so a large backlog never exceeds the BSON command size limit.
    for (let i = 0; i < stale.length; i += TRIM_DELETE_BATCH) {
      const ids = stale.slice(i, i + TRIM_DELETE_BATCH).map((d) => d._id)
      await this.messages.deleteMany({ _id: { $in: ids } })
    }
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    if (!ref.id || !ref.chatId) return undefined
    const key = messageKey(ref)
    const found = await this.messageIn(key, ref)
    if (found) return found
    // Documents written before keys were escaped (only differs when an id has ':' or '%').
    const legacy = legacyMessageKey(ref)
    return legacy === key ? undefined : this.messageIn(legacy, ref)
  }

  /**
   * The message stored under `key` when it IS `ref`. A legacy key alone may
   * belong to another chat, or be another message's escaped key, so the
   * document's own ref is checked.
   */
  private async messageIn(key: string, ref: MessageRef): Promise<StoredMessage | undefined> {
    const doc = await this.messages.findOne({ _id: key }, READ)
    const msg = doc?.chatId === ref.chatId ? doc.msg : undefined
    return msg?.ref?.id === ref.id && msg?.ref?.chatId === ref.chatId ? msg : undefined
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    // MemoryStore's window for ANY number: non-positive/NaN gives nothing, a
    // fraction rounds up, Infinity means everything. MongoDB reads limit(0) as
    // "no limit" and limit(-n) as n, and rejects a fraction, so normalize first.
    if (!(limit > 0)) return []
    // Latest `limit` messages, newest first, then flipped to oldest -> newest.
    const cursor = this.messages.find({ chatId }, READ).sort(NEWEST_FIRST)
    if (limit <= MAX_LIMIT) cursor.limit(Math.ceil(limit)) // beyond: every message, i.e. no limit at all
    const docs = await cursor.toArray()
    return docs.reverse().map((d) => d.msg)
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    // Both key formats, scoped to the chat and to THIS message (see ownedBy).
    await this.messages.deleteMany({
      _id: { $in: [messageKey(ref), legacyMessageKey(ref)] },
      chatId: ref.chatId,
      ...ownedBy(ref),
    })
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    await this.chats.updateOne({ _id: chat.id }, shallowMerge(chat), UPSERT)
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const doc = await this.chats.findOne({ _id: chatId }, READ)
    if (!doc) return undefined
    const { _id, ...chat } = doc
    return chat
  }
  async listChats(): Promise<StoredChat[]> {
    const docs = await this.chats.find({}, READ).toArray()
    return docs.map(({ _id, ...chat }) => chat)
  }
  /** Removes the chat document AND purges its message log (consistent with MemoryStore). */
  async deleteChat(chatId: string): Promise<void> {
    await this.messages.deleteMany({ chatId })
    await this.chats.deleteOne({ _id: chatId })
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    await this.contacts.updateOne({ _id: contact.id }, shallowMerge(contact), UPSERT)
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const doc = await this.contacts.findOne({ _id: userId }, READ)
    if (!doc) return undefined
    const { _id, ...contact } = doc
    return contact
  }
  async listContacts(): Promise<StoredContact[]> {
    const docs = await this.contacts.find({}, READ).toArray()
    return docs.map(({ _id, ...contact }) => contact)
  }

  async deleteContact(userId: string): Promise<void> {
    await this.contacts.deleteOne({ _id: userId })
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    return (await this.cursors.findOne({ _id: key }))?.value
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.cursors.updateOne({ _id: key }, { $set: { value } }, UPSERT)
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    return (await this.checkpoints.findOne({ _id: key }, READ))?.cp
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    await this.checkpoints.updateOne({ _id: key }, { $set: { cp } }, UPSERT)
  }
  async clearCheckpoint(key: string): Promise<void> {
    await this.checkpoints.deleteOne({ _id: key })
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const docs = await this.checkpoints.find({}, READ).toArray()
    return docs.map((d) => [d._id, d.cp])
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    return (await this.conversations.findOne({ _id: key }, READ))?.messages
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    await this.conversations.updateOne({ _id: key }, { $set: { messages } }, UPSERT)
  }
  async clearConversation(key: string): Promise<void> {
    await this.conversations.deleteOne({ _id: key })
  }

  /* User data (ctx.user) — collection `user_data`, lazy expiry + purge ---- */

  async getUserData(userId: UserId, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    return this.userData.get(userId, namespace, key, Date.now())
  }
  /** Upsert one entry; rejects with a `TypeError` when `value` is not JSON-serialisable. */
  async setUserData(entry: UserDataEntry): Promise<void> {
    await this.userData.set(entry)
  }
  async deleteUserData(userId: UserId, namespace?: string, key?: string): Promise<void> {
    await this.userData.delete(userId, namespace, key)
  }
  async listUserData(userId: UserId, namespace?: string): Promise<UserDataEntry[]> {
    return this.userData.list(userId, namespace, Date.now())
  }
  /** Delete every expired user-data document (all users) in batches of `purgeBatchSize`; resolves with the count. */
  async purgeExpiredUserData(now: number = Date.now()): Promise<number> {
    return this.userData.purge(now)
  }

  /* Durable scheduler ------------------------------------------------------ */

  private scheduleStore?: MongoScheduleStore

  /**
   * The durable scheduler's store on this store's client and database (collection
   * `{collectionPrefix}schedules`): `new Bot({ store, scheduler: { store: store.schedules() } })`.
   * Always the same instance.
   */
  schedules(): MongoScheduleStore {
    return (this.scheduleStore ??= new MongoScheduleStore({
      collection: this.client.db(this.dbName).collection(`${this.collectionPrefix}schedules`),
    }))
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    // Injected clients are caller-managed; never connect/close them.
    if (this.ownsClient && !this.started) await this.client.connect()
    // Backs the per-chat time-ordered read in getMessagesByChat and the trim,
    // including the `_id` tie-break. Idempotent (same spec = no-op). Stores
    // created by older versions also keep a now-redundant
    // `chatId_1_timestamp_1` index, which can be dropped by hand.
    await this.messages.createIndex({ chatId: 1, timestamp: 1, _id: 1 })
    await this.userData.ensureIndexes()
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
