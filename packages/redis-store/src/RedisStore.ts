/**
 * RedisStore — distributed {@link IStore} backed by Redis (node-redis v4).
 *
 * All state is JSON under a configurable key prefix, so any number of bot
 * replicas can share one Redis instance. Per-chat message logs are sorted
 * sets (score = timestamp), which makes "last N messages" an O(log N + N)
 * `ZRANGE` instead of a scan.
 *
 * The client is injectable (`opts.client`) so tests — and callers that own a
 * connection pool — never need a live Redis. When no client is injected,
 * `start()` creates and connects one, and `stop()` quits it.
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 * import { RedisStore } from '@bot-wa/redis-store'
 *
 * const store = new RedisStore({ url: 'redis://localhost:6379', prefix: 'mybot' })
 * const bot = new Bot({
 *   provider: new BaileysProvider({ session: 'demo' }),
 *   store,
 * })
 * await store.start()
 * ```
 */

import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'
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
import { RedisUserData } from './userData.js'

/** Lua compare-and-delete: only DEL the lock if the token still matches. */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

/** The native node-redis v4 client type produced by `createClient` (modules bundled by `redis`). */
export type NativeRedisClient = ReturnType<typeof createClient>

/** Options for {@link RedisLikeClient.zRange} / zRangeWithScores. */
export interface RedisZRangeOptions {
  BY?: 'SCORE' | 'LEX'
  REV?: true
  LIMIT?: { offset: number; count: number }
}

/**
 * Structural subset of the node-redis v4 client used by {@link RedisStore}.
 * Tests inject an in-memory fake (see tests/fakeRedis.ts); a real client is
 * accepted through {@link RedisStoreOptions.client} via {@link NativeRedisClient}
 * (the native command typings are too fancy for direct structural assignability,
 * so the store narrows it at the boundary). Only string replies are expected —
 * do NOT inject a client configured with `returnBuffers: true`.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: { NX?: true; XX?: true; EX?: number; PX?: number },
  ): Promise<string | null>
  del(key: string | string[]): Promise<number>
  keys(pattern: string): Promise<string[]>
  zAdd(
    key: string,
    members: { score: number; value: string } | Array<{ score: number; value: string }>,
    options?: { NX?: true; XX?: true },
  ): Promise<number>
  zRange(
    key: string,
    min: number | string,
    max: number | string,
    options?: RedisZRangeOptions,
  ): Promise<string[]>
  zRangeWithScores(
    key: string,
    min: number | string,
    max: number | string,
    options?: RedisZRangeOptions,
  ): Promise<Array<{ score: number; value: string }>>
  zRem(key: string, member: string | string[]): Promise<number>
  zCard(key: string): Promise<number>
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>
  /** Begin a MULTI transaction — queued commands execute atomically on exec(). */
  multi(): RedisMulti
  connect(): Promise<unknown>
  quit(): Promise<unknown>
  /** Connection state; when true, start() skips connecting an own client. */
  isOpen?: boolean
}

/**
 * Minimal chainable MULTI surface (node-redis v4). Only the commands the store
 * batches are declared; each returns the transaction for chaining, and `exec()`
 * runs them atomically.
 */
export interface RedisMulti {
  set(key: string, value: string, options?: { NX?: true; XX?: true; EX?: number; PX?: number }): RedisMulti
  del(key: string | string[]): RedisMulti
  zAdd(key: string, members: { score: number; value: string } | Array<{ score: number; value: string }>, options?: { NX?: true; XX?: true }): RedisMulti
  zRem(key: string, member: string | string[]): RedisMulti
  exec(): Promise<unknown[]>
}

export interface RedisStoreOptions {
  /** Redis connection URL. Default: 'redis://localhost:6379'. Ignored when `client` is given. */
  url?: string
  /** Namespace prefix for every key the store writes. Default: 'botwa'. */
  prefix?: string
  /**
   * Inject an existing client (typically already connected) — a real
   * node-redis client or any {@link RedisLikeClient} (e.g. an in-memory fake,
   * REQUIRED for hermetic tests). The store then never connects or quits it —
   * the caller owns the lifecycle.
   */
  client?: RedisLikeClient | NativeRedisClient
  /**
   * Optional TTL in SECONDS applied to ephemeral session-state keys (AI
   * conversation history and flow checkpoints). Messages, chats, contacts
   * and cursors are never expired — delete them explicitly.
   */
  ttl?: number
  /**
   * Max messages retained per chat. When set, `saveMessage` prunes the oldest
   * entries (by score/timestamp) beyond the cap — both the ZSET members and
   * their item keys. Default: undefined = unbounded.
   */
  maxMessagesPerChat?: number
  logger?: { error?: (...args: unknown[]) => void }
}

function toStr(value: string | Buffer | null | undefined): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : value.toString()
}

export class RedisStore implements IStore {
  private readonly client: RedisLikeClient
  private readonly ownsClient: boolean
  private readonly prefix: string
  private readonly ttl?: number
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }
  private readonly userData: RedisUserData

  constructor(opts: RedisStoreOptions = {}) {
    this.prefix = opts.prefix ?? 'botwa'
    this.ttl = opts.ttl
    this.maxMessagesPerChat = opts.maxMessagesPerChat
    this.logger = opts.logger
    // node-redis' generated command signatures aren't directly assignable to a
    // plain interface (union-rest + MaximumOneOf option types); the command
    // subset used here matches at runtime, so narrow at the boundary.
    const client = opts.client ?? createClient({ url: opts.url ?? 'redis://localhost:6379' })
    this.client = client as RedisLikeClient
    this.ownsClient = !opts.client
    this.userData = new RedisUserData(this.client, this.prefix)
  }

  /* Key scheme (all namespaced by prefix) --------------------------------- *
   *   {prefix}:msg:{chatId}             ZSET messageKey -> timestamp
   *   {prefix}:msg:item:{chatId}:{id}   JSON StoredMessage
   *   {prefix}:chat:{id}                JSON StoredChat
   *   {prefix}:contact:{id}             JSON StoredContact
   *   {prefix}:cp:{key}                 JSON FlowCheckpoint   (ttl-aware)
   *   {prefix}:conv:{key}               JSON AIMessage[]      (ttl-aware)
   *   {prefix}:cursor:{key}             string
   *   {prefix}:lock:{key}               token (SET NX PX)
   *   {prefix}:ud:{user}:{ns}:{key}     JSON user-data entry (native PX expiry; segments percent-encoded)
   * ---------------------------------------------------------------------- */

  private msgSetKey(chatId: string): string {
    return `${this.prefix}:msg:${chatId}`
  }
  /** Item key for a ZSET member (member === `${chatId}:${id}` === messageKey). */
  private msgItemKey(member: string): string {
    return `${this.prefix}:msg:item:${member}`
  }
  private chatKey(id: string): string {
    return `${this.prefix}:chat:${id}`
  }
  private contactKey(id: string): string {
    return `${this.prefix}:contact:${id}`
  }
  private checkpointKey(key: string): string {
    return `${this.prefix}:cp:${key}`
  }
  private conversationKey(key: string): string {
    return `${this.prefix}:conv:${key}`
  }
  private cursorKey(key: string): string {
    return `${this.prefix}:cursor:${key}`
  }
  private lockKey(key: string): string {
    return `${this.prefix}:lock:${key}`
  }

  /** SET with the configured TTL (seconds) when one is set, plain SET otherwise. */
  private setMaybeTtl(key: string, value: string): Promise<string | null> {
    return this.ttl != null ? this.client.set(key, value, { EX: this.ttl }) : this.client.set(key, value)
  }

  /** KEYS scan + prefix strip. Fine at bot scale; swap for SCAN if keyspace is huge. */
  private async scanIds(namespace: string): Promise<Array<{ key: string; id: string }>> {
    const keys = await this.client.keys(`${namespace}*`)
    return keys.map((key) => ({ key, id: key.slice(namespace.length) }))
  }

  /* Messages -------------------------------------------------------------- */

  async saveMessage(msg: StoredMessage): Promise<void> {
    const member = messageKey(msg.ref)
    // Atomic: the item write and the ZSET index entry commit together, so a
    // failure can never leave a ZSET member without its item (which would make
    // getMessagesByChat silently return fewer than `limit` rows).
    await this.client
      .multi()
      .set(this.msgItemKey(member), JSON.stringify(msg))
      .zAdd(this.msgSetKey(msg.chatId), { score: msg.timestamp, value: member })
      .exec()
    await this.trimChat(msg.chatId)
  }

  /** Prune the oldest messages of a chat beyond `maxMessagesPerChat` (ZSET members + item keys). */
  private async trimChat(chatId: string): Promise<void> {
    if (this.maxMessagesPerChat == null) return
    const setKey = this.msgSetKey(chatId)
    const count = await this.client.zCard(setKey)
    const overflow = count - this.maxMessagesPerChat
    if (overflow <= 0) return
    // Oldest `overflow` members (lowest scores first).
    const stale = await this.client.zRange(setKey, '-inf', '+inf', {
      BY: 'SCORE',
      LIMIT: { offset: 0, count: overflow },
    })
    if (!stale.length) return
    const tx = this.client.multi()
    tx.del(stale.map((m) => this.msgItemKey(m)))
    tx.zRem(setKey, stale)
    await tx.exec()
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    const raw = await this.client.get(this.msgItemKey(messageKey(ref)))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as StoredMessage)
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    // Latest `limit` entries, newest first (REV swaps the bound order).
    const members = await this.client.zRange(this.msgSetKey(chatId), '+inf', '-inf', {
      BY: 'SCORE',
      REV: true,
      LIMIT: { offset: 0, count: limit },
    })
    const items = await Promise.all(members.map((m) => this.client.get(this.msgItemKey(m))))
    const messages: StoredMessage[] = []
    for (const raw of items) {
      if (raw != null) messages.push(JSON.parse(toStr(raw)) as StoredMessage)
    }
    return messages.reverse() // oldest -> newest
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    const member = messageKey(ref)
    // Atomic: drop the item and its ZSET index entry together (no orphan member).
    await this.client
      .multi()
      .del(this.msgItemKey(member))
      .zRem(this.msgSetKey(ref.chatId), member)
      .exec()
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    // Shallow-merge over any existing record so a partial upsert keeps prior
    // fields — consistent with MemoryStore/MongoStore.
    const existing = await this.getChat(chat.id)
    await this.client.set(this.chatKey(chat.id), JSON.stringify({ ...existing, ...chat }))
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const raw = await this.client.get(this.chatKey(chatId))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as StoredChat)
  }
  async listChats(): Promise<StoredChat[]> {
    const out: StoredChat[] = []
    for (const { key } of await this.scanIds(`${this.prefix}:chat:`)) {
      const raw = await this.client.get(key)
      if (raw != null) out.push(JSON.parse(toStr(raw)) as StoredChat)
    }
    return out
  }
  /**
   * Removes the chat record AND purges its entire message log — the ZSET index
   * plus every message item (consistent with MemoryStore). Previously only the
   * chat key was deleted, leaking the ZSET and all `:msg:item:` keys forever.
   */
  async deleteChat(chatId: string): Promise<void> {
    const members = await this.client.zRange(this.msgSetKey(chatId), '-inf', '+inf', { BY: 'SCORE' })
    const tx = this.client.multi()
    if (members.length) tx.del(members.map((m) => this.msgItemKey(m)))
    tx.del(this.msgSetKey(chatId))
    tx.del(this.chatKey(chatId))
    await tx.exec()
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    const existing = await this.getContact(contact.id)
    await this.client.set(this.contactKey(contact.id), JSON.stringify({ ...existing, ...contact }))
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const raw = await this.client.get(this.contactKey(userId))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as StoredContact)
  }
  async listContacts(): Promise<StoredContact[]> {
    const out: StoredContact[] = []
    for (const { key } of await this.scanIds(`${this.prefix}:contact:`)) {
      const raw = await this.client.get(key)
      if (raw != null) out.push(JSON.parse(toStr(raw)) as StoredContact)
    }
    return out
  }

  async deleteContact(userId: string): Promise<void> {
    await this.client.del(this.contactKey(userId))
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    return (await this.client.get(this.cursorKey(key))) ?? undefined
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.client.set(this.cursorKey(key), value)
  }

  /* Flow checkpoints (ttl-aware) ------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    const raw = await this.client.get(this.checkpointKey(key))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as FlowCheckpoint)
  }
  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    await this.setMaybeTtl(this.checkpointKey(key), JSON.stringify(cp))
  }
  async clearCheckpoint(key: string): Promise<void> {
    await this.client.del(this.checkpointKey(key))
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const out: Array<[string, FlowCheckpoint]> = []
    for (const { key, id } of await this.scanIds(`${this.prefix}:cp:`)) {
      const raw = await this.client.get(key)
      if (raw != null) out.push([id, JSON.parse(toStr(raw)) as FlowCheckpoint])
    }
    return out
  }

  /* AI conversation history (ttl-aware) ------------------------------------ */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const raw = await this.client.get(this.conversationKey(key))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as AIMessage[])
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    await this.setMaybeTtl(this.conversationKey(key), JSON.stringify(messages))
  }
  async clearConversation(key: string): Promise<void> {
    await this.client.del(this.conversationKey(key))
  }

  /* User data (ctx.user) — one key per entry, native expiry --------------- */

  async getUserData(userId: UserId, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    return this.userData.get(userId, namespace, key, Date.now())
  }
  async setUserData(entry: UserDataEntry): Promise<void> {
    await this.userData.set(entry, Date.now())
  }
  async deleteUserData(userId: UserId, namespace?: string, key?: string): Promise<void> {
    await this.userData.delete(userId, namespace, key)
  }
  async listUserData(userId: UserId, namespace?: string): Promise<UserDataEntry[]> {
    return this.userData.list(userId, namespace, Date.now())
  }
  /** Always resolves 0: user-data keys carry a native PX expiry, so Redis removes them itself. */
  async purgeExpiredUserData(_now?: number): Promise<number> {
    return 0
  }

  /* Distributed lock (building block; the core does not use it yet) -------- */

  /**
   * Try to acquire a distributed lock at `{prefix}:lock:{key}`.
   *
   * Returns an opaque token on success — pass it to {@link releaseLock} — or
   * `null` when the lock is already held. The lock auto-expires after `ttlMs`
   * so a crashed holder never wedges the fleet.
   *
   * LIMITATIONS — read before relying on this for mutual exclusion:
   *  - **No fencing token.** The returned token only proves ownership to
   *    {@link releaseLock}; it is NOT a monotonic fence a protected resource can
   *    use to reject a stale holder. If a holder stalls (GC/IO pause) past
   *    `ttlMs`, the lock expires, another client acquires it, and BOTH may run
   *    the critical section concurrently. Size `ttlMs` well above worst-case
   *    section time, and make the protected work idempotent.
   *  - **No auto-renewal (watchdog).** A section longer than `ttlMs` is not safe.
   *  - **Not Redlock.** On a single master, a `SET NX` can be lost if the master
   *    fails over before replicating. Do not use for correctness-critical mutual
   *    exclusion across a failover-capable cluster.
   *
   * It is a best-effort coordination primitive, adequate for at-most-once-ish
   * scheduling of idempotent work — not a guarantee of strict exclusion.
   */
  async acquireLock(key: string, ttlMs = 30_000): Promise<string | null> {
    const token = randomUUID()
    const acquired = await this.client.set(this.lockKey(key), token, { NX: true, PX: ttlMs })
    return acquired === 'OK' ? token : null
  }

  /**
   * Release a lock ONLY if `token` still owns it (Lua compare-and-delete,
   * atomic). Returns true when the lock was released, false when it was
   * already expired or owned by someone else.
   */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const result = await this.client.eval(RELEASE_LOCK_SCRIPT, {
      keys: [this.lockKey(key)],
      arguments: [token],
    })
    return Number(result) === 1
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    // Injected clients are caller-managed; never connect/quit them.
    if (this.ownsClient && this.client.isOpen !== true) await this.client.connect()
  }
  async stop(): Promise<void> {
    if (!this.ownsClient) return
    try {
      await this.client.quit()
    } catch (err) {
      this.logger?.error?.({ err }, 'RedisStore failed to quit client')
    }
  }
}
