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
import { messageKey, parseDuration } from '@bot-wa/core'
import { RedisUserData } from './userData.js'
import { escapeGlob } from './glob.js'
import { matchKeys } from './keys.js'
import { MERGE_CAS_SCRIPT, RELEASE_LOCK_SCRIPT } from './scripts.js'

/**
 * Compare-and-set attempts per upsert. Each failed attempt means another
 * writer's upsert of the same record landed, so the fleet always progresses;
 * the cap only turns pathological contention into an error instead of a spin.
 */
const MERGE_MAX_ATTEMPTS = 50

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
  /**
   * Incremental SCAN over keys matching `MATCH` (node-redis). Optional: when
   * present, the store enumerates keys with it instead of the blocking `KEYS`.
   * node-redis v4 yields one key per step, v5 an array of keys; both work.
   */
  scanIterator?(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string | string[]>
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
  /**
   * Drop the connection without waiting for pending replies. Optional; when
   * present, stop() uses it instead of quit() while the client is not ready
   * (quit() would wait for a reconnect that may never come).
   */
  disconnect?(): Promise<unknown>
  /** Connection state; when true, start() skips connecting an own client. */
  isOpen?: boolean
  /** Socket connected and handshake done (node-redis). `false` makes stop() disconnect instead of quit. */
  isReady?: boolean
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
   * Optional TTL applied to ephemeral session-state keys (AI conversation
   * history and flow checkpoints): a duration (`'24h'`, `'30m'`) or a number of
   * MILLISECONDS — the same convention as every duration option of
   * `@bot-wa/core`. Messages, chats, contacts and cursors are never expired —
   * delete them explicitly. Must be positive; an invalid duration or a
   * non-positive value throws from the constructor.
   */
  sessionTtl?: string | number
  /**
   * Optional TTL in SECONDS applied to ephemeral session-state keys. Must be a
   * positive finite number (fractions allowed, applied with millisecond
   * precision); anything else throws a `RangeError` from the constructor.
   * Setting both `ttl` and `sessionTtl` throws a `RangeError`.
   *
   * @deprecated Use {@link RedisStoreOptions.sessionTtl} (a duration or ms, like
   * the rest of the framework): `ttl: 3600` is `sessionTtl: '1h'`.
   */
  ttl?: number
  /**
   * Max messages retained per chat. When set, `saveMessage` prunes the oldest
   * entries (by score/timestamp) beyond the cap — both the ZSET members and
   * their item keys. Must be a non-negative integer (else `RangeError`).
   * Default: undefined = unbounded.
   */
  maxMessagesPerChat?: number
  /**
   * Receives client errors (connection drops, failed reconnects) of a
   * store-created client, and lifecycle errors (e.g. quit failure). An
   * injected client's errors are the caller's to handle.
   */
  logger?: { error?: (...args: unknown[]) => void }
}

/** node-redis' default reconnect backoff: 0, 50, 100 … capped at 500 ms. */
const reconnectDelay = (retries: number): number => Math.min(retries * 50, 500)

/** How long stop() waits for the reply to QUIT before dropping the connection. */
const QUIT_TIMEOUT_MS = 2_000

function toStr(value: string | Buffer | null | undefined): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : value.toString()
}

/**
 * Unwrap node-redis' ReconnectStrategyError so start() rejects with the socket
 * error itself (e.g. `code: 'ECONNREFUSED'`), not the strategy wrapper.
 */
function connectError(err: unknown): unknown {
  if (err instanceof Error && 'socketError' in err && err.socketError instanceof Error) return err.socketError
  return err
}

export class RedisStore implements IStore {
  private readonly client: RedisLikeClient
  private readonly ownsClient: boolean
  private readonly prefix: string
  /** `sessionTtl` / `ttl` option converted to milliseconds (sent as PX: EX only takes whole seconds). */
  private readonly ttlMs?: number
  private readonly maxMessagesPerChat?: number
  private readonly logger?: { error?: (...args: unknown[]) => void }
  /**
   * True between a successful start() and stop(): a dropped connection is then
   * retried with backoff. Before the first connect (and after stop()) the
   * reconnect strategy gives up at once, so start() fails fast on an
   * unreachable server instead of retrying forever.
   */
  private keepReconnecting = false
  /** In-flight connect of an own client, shared by concurrent start() calls. */
  private connecting?: Promise<void>
  /** Tail of the pending in-process upsert chain per record key (see {@link mergeRecord}). */
  private readonly mergeChains = new Map<string, Promise<void>>()
  private readonly userData: RedisUserData

  constructor(opts: RedisStoreOptions = {}) {
    this.prefix = opts.prefix ?? 'botwa'
    if (opts.sessionTtl != null && opts.ttl != null) {
      throw new RangeError('RedisStore: set either sessionTtl or the deprecated ttl, not both')
    }
    if (opts.sessionTtl != null) {
      const ms = parseDuration(opts.sessionTtl)
      if (!(ms > 0) || !Number.isFinite(ms)) {
        throw new RangeError(`RedisStore: sessionTtl must be a positive duration, got ${String(opts.sessionTtl)}`)
      }
      this.ttlMs = Math.max(1, Math.round(ms))
    }
    if (opts.ttl != null) {
      // The server rejects a non-integer EX and any non-positive expiry, which
      // previously surfaced as an error on every checkpoint/conversation write.
      if (!(opts.ttl > 0) || !Number.isFinite(opts.ttl)) {
        throw new RangeError(`RedisStore: ttl must be a positive number of seconds, got ${opts.ttl}`)
      }
      this.ttlMs = Math.max(1, Math.round(opts.ttl * 1000))
    }
    if (opts.maxMessagesPerChat != null && !(Number.isInteger(opts.maxMessagesPerChat) && opts.maxMessagesPerChat >= 0)) {
      throw new RangeError(`RedisStore: maxMessagesPerChat must be a non-negative integer, got ${opts.maxMessagesPerChat}`)
    }
    this.maxMessagesPerChat = opts.maxMessagesPerChat
    this.logger = opts.logger
    // node-redis' generated command signatures aren't directly assignable to a
    // plain interface (union-rest + MaximumOneOf option types); the command
    // subset used here matches at runtime, so narrow at the boundary.
    this.client = (opts.client ?? this.createOwnClient(opts.url ?? 'redis://localhost:6379')) as RedisLikeClient
    this.ownsClient = !opts.client
    this.userData = new RedisUserData(this.client, this.prefix)
  }

  private createOwnClient(url: string): NativeRedisClient {
    const client = createClient({
      url,
      socket: {
        reconnectStrategy: (retries: number, cause: Error) => (this.keepReconnecting ? reconnectDelay(retries) : cause),
      },
    })
    // node-redis re-throws an 'error' event nobody listens to: without this, a
    // dropped connection (server restart, network blip) crashed the process
    // instead of reconnecting. Guarded because test doubles may not be emitters.
    if (typeof client.on === 'function') {
      client.on('error', (err: unknown) => this.logger?.error?.({ err }, 'RedisStore client error'))
    }
    return client
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

  /** SET with the configured TTL when one is set, plain SET otherwise. */
  private setMaybeTtl(key: string, value: string): Promise<string | null> {
    return this.ttlMs != null ? this.client.set(key, value, { PX: this.ttlMs }) : this.client.set(key, value)
  }

  /** Keys under `namespace` (SCAN when the client supports it, else KEYS) + prefix strip. */
  private async scanIds(namespace: string): Promise<Array<{ key: string; id: string }>> {
    const keys = await matchKeys(this.client, `${escapeGlob(namespace)}*`)
    return keys.map((key) => ({ key, id: key.slice(namespace.length) }))
  }

  /**
   * GET every JSON record under `namespace` in parallel (node-redis pipelines
   * concurrent commands), skipping keys deleted or expired since the scan.
   * The former one-GET-per-await loop cost one round trip per record.
   */
  private async listRecords<T>(namespace: string): Promise<Array<{ id: string; value: T }>> {
    const ids = await this.scanIds(namespace)
    const raws = await Promise.all(ids.map(({ key }) => this.client.get(key)))
    const out: Array<{ id: string; value: T }> = []
    raws.forEach((raw, i) => {
      if (raw != null) out.push({ id: ids[i]!.id, value: JSON.parse(toStr(raw)) as T })
    })
    return out
  }

  /**
   * Shallow-merge `patch` over the JSON record at `key` (upsert semantics,
   * exactly MemoryStore's `{ ...existing, ...patch }`: an explicit `undefined`
   * removes the field, since JSON drops it).
   *
   * A plain GET + SET is not atomic: two concurrent upserts of one record (Bot
   * does this for inbound and outbound traffic of the same chat, and every
   * replica does it for the chats they share) both read the old value and the
   * later SET drops the other's fields. So the write is an optimistic
   * compare-and-set ({@link MERGE_CAS_SCRIPT}, atomic on the server): it only
   * lands if the record is still the exact string the merge was computed from,
   * otherwise the record is re-read and the merge retried — safe across
   * processes. The merge itself stays in JS because a cjson round-trip on the
   * server would alter values. Upserts of one key are also chained in-process
   * so a single replica does not race (and retry) against itself.
   */
  private mergeRecord(key: string, patch: object): Promise<void> {
    const previous = this.mergeChains.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      for (let attempt = 0; attempt < MERGE_MAX_ATTEMPTS; attempt++) {
        const raw = await this.client.get(key)
        const current = raw == null ? null : toStr(raw)
        const existing = current == null ? undefined : (JSON.parse(current) as object)
        const merged = JSON.stringify({ ...existing, ...patch })
        const written = await this.client.eval(MERGE_CAS_SCRIPT, {
          keys: [key],
          // ['0', ''] = "the key must still be absent"; ['1', raw] = "it must still be exactly raw".
          arguments: current == null ? ['0', '', merged] : ['1', current, merged],
        })
        if (Number(written) === 1) return
      }
      throw new Error(`RedisStore: gave up upserting ${key} after ${MERGE_MAX_ATTEMPTS} attempts (write contention)`)
    })
    const tail = run.catch(() => {}) // a failed upsert must not poison the next one
    this.mergeChains.set(key, tail)
    void tail.then(() => {
      if (this.mergeChains.get(key) === tail) this.mergeChains.delete(key)
    })
    return run
  }

  /* Messages -------------------------------------------------------------- */

  /**
   * Upsert keyed by `messageKey(ref)`. A message without `ref.id` or `chatId`
   * is ignored, like MemoryStore: providers send `''` when they have no stable
   * id, and keying those would make them overwrite each other.
   */
  async saveMessage(msg: StoredMessage): Promise<void> {
    if (!msg.ref?.id || !msg.chatId) return
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
    const cap = this.maxMessagesPerChat
    if (cap == null) return
    const setKey = this.msgSetKey(chatId)
    const count = await this.client.zCard(setKey)
    if (count <= cap) return
    // Select the members ranked BELOW the newest `cap`, in one command at one
    // instant. Taking "the oldest `count - cap`" instead raced with concurrent
    // trims from other connections/replicas: once another trim had pruned,
    // the stale `count` made this one cut into the newest `cap` (data loss).
    // A member that is beyond the cap at any instant stays beyond it, so this
    // can never over-prune; `count - cap` only bounds how many go per call.
    const stale = await this.client.zRange(setKey, '+inf', '-inf', {
      BY: 'SCORE',
      REV: true,
      LIMIT: { offset: cap, count: count - cap },
    })
    if (!stale.length) return
    const tx = this.client.multi()
    tx.del(stale.map((m) => this.msgItemKey(m)))
    tx.zRem(setKey, stale)
    await tx.exec()
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    if (!ref.id || !ref.chatId) return undefined
    const raw = await this.client.get(this.msgItemKey(messageKey(ref)))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as StoredMessage)
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    // Same window as MemoryStore's slice for ANY number: non-positive/NaN gives
    // nothing, a fraction rounds up, Infinity means everything. Redis' LIMIT
    // only takes integers (it rejected 2.5 and Infinity) and reads a negative
    // count as "all", so normalize before it reaches the server.
    if (!(limit > 0)) return []
    const count = Math.min(Math.ceil(limit), Number.MAX_SAFE_INTEGER)
    // Latest `count` entries, newest first (REV swaps the bound order).
    const members = await this.client.zRange(this.msgSetKey(chatId), '+inf', '-inf', {
      BY: 'SCORE',
      REV: true,
      LIMIT: { offset: 0, count },
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
    await this.mergeRecord(this.chatKey(chat.id), chat)
  }
  async getChat(chatId: string): Promise<StoredChat | undefined> {
    const raw = await this.client.get(this.chatKey(chatId))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as StoredChat)
  }
  async listChats(): Promise<StoredChat[]> {
    return (await this.listRecords<StoredChat>(`${this.prefix}:chat:`)).map((r) => r.value)
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
    await this.mergeRecord(this.contactKey(contact.id), contact)
  }
  async getContact(userId: string): Promise<StoredContact | undefined> {
    const raw = await this.client.get(this.contactKey(userId))
    return raw == null ? undefined : (JSON.parse(toStr(raw)) as StoredContact)
  }
  async listContacts(): Promise<StoredContact[]> {
    return (await this.listRecords<StoredContact>(`${this.prefix}:contact:`)).map((r) => r.value)
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
    return (await this.listRecords<FlowCheckpoint>(`${this.prefix}:cp:`)).map((r) => [r.id, r.value])
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
  /** Upsert one entry; rejects with a `TypeError` when `value` is not JSON-serialisable. */
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
    // PX only takes a positive integer: the server rejected fractions, and a
    // lock without a finite deadline would defeat the crash-safety guarantee.
    if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) {
      throw new RangeError(`RedisStore.acquireLock: ttlMs must be a positive number, got ${ttlMs}`)
    }
    const token = randomUUID()
    const acquired = await this.client.set(this.lockKey(key), token, { NX: true, PX: Math.ceil(ttlMs) })
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

  /**
   * Connect a store-created client (idempotent; concurrent calls share one
   * connect). Rejects promptly with the socket error when the server is
   * unreachable — call it again to retry. Injected clients are caller-managed
   * and never connected here.
   */
  async start(): Promise<void> {
    if (!this.ownsClient) return
    if (this.connecting) return this.connecting
    if (this.client.isOpen === true) return
    this.connecting = (async () => {
      this.keepReconnecting = false // the first attempt fails fast; retry with backoff only once connected
      try {
        await this.client.connect()
        this.keepReconnecting = true
      } catch (err) {
        throw connectError(err)
      } finally {
        this.connecting = undefined
      }
    })()
    return this.connecting
  }

  /**
   * Close a store-created client (idempotent; injected clients are left
   * alone). Never waits on an unreachable server: a client that is not ready
   * is disconnected instead of sent a QUIT that would queue until a reconnect.
   */
  async stop(): Promise<void> {
    if (!this.ownsClient) return
    if (this.connecting) await this.connecting.catch(() => {})
    this.keepReconnecting = false // an in-flight reconnect loop gives up instead of retrying forever
    if (this.client.isOpen !== true) return
    try {
      await this.closeOwnClient()
    } catch (err) {
      this.logger?.error?.({ err }, 'RedisStore failed to close client')
    }
  }

  /** Graceful QUIT (pending replies still arrive), bounded so stop() can never hang. */
  private async closeOwnClient(): Promise<void> {
    const { client } = this
    if (client.isReady === false && client.disconnect) {
      await client.disconnect()
      return
    }
    const quit = client.quit()
    quit.catch(() => {}) // still awaited below; this only covers the timeout path
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), QUIT_TIMEOUT_MS)
    })
    try {
      if ((await Promise.race([quit.then(() => false as const), timedOut])) && client.disconnect) {
        // The socket closed cleanly after QUIT was written (e.g. the server
        // restarted): node-redis then never settles QUIT. disconnect() flushes
        // the queue (rejecting it) and only then complains the client is closed.
        await client.disconnect().catch(() => {})
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
