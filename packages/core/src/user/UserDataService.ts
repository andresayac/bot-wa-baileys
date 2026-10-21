/**
 * UserDataService — builds `ctx.user` handles over an {@link IStore} and owns
 * the cross-chat write serialisation, TTL handling and opportunistic purge.
 *
 * One instance per Bot (shared by every message context) so that writes of the
 * same user coming from different chats — which the per-chat dispatcher queue
 * does NOT serialise — still run one at a time. See {@link UserData} for the
 * full semantics.
 *
 * @example
 * ```ts
 * // Standalone (e.g. a worker that shares the bot's store):
 * const profiles = new UserDataService(store)
 * await profiles.for('5491122334455').ns('billing').set('plan', 'pro')
 * ```
 */

import type { IStore, UserDataEntry, UserId } from '../core/provider.js'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import { parseDuration } from '../utils/timers.js'
import { UserDataError } from './errors.js'
import { KeyedQueue } from '../utils/keyedQueue.js'
import { assertNamespace, assertUserId, getAt, parsePath, setAt, toJsonValue, unsetAt } from './paths.js'
import type { UserData, UserSetOptions } from './types.js'

/** Namespace used by `ctx.user` / `bot.user(id)`. */
export const DEFAULT_USER_NAMESPACE = 'default'

const DEFAULT_PURGE_INTERVAL_MS = 60_000

/** An IStore whose user-data methods are all present. */
export type UserDataStore = IStore & Required<Pick<IStore, 'getUserData' | 'setUserData' | 'deleteUserData' | 'listUserData'>>

/**
 * Whether `store` implements the user-data contract (`getUserData`,
 * `setUserData`, `deleteUserData`, `listUserData`; `purgeExpiredUserData` is
 * optional). All built-in stores do; custom stores may not.
 */
export function supportsUserData(store: IStore): store is UserDataStore {
  return typeof store.getUserData === 'function'
    && typeof store.setUserData === 'function'
    && typeof store.deleteUserData === 'function'
    && typeof store.listUserData === 'function'
}

export interface UserDataServiceOptions {
  /**
   * Minimum time between the opportunistic purges of expired entries that
   * writes trigger (`store.purgeExpiredUserData`, store-wide). Duration string
   * or ms; `0` purges on every write; `false` disables it (schedule
   * `bot.purgeExpiredUserData()` yourself). Default `'1m'`. Purge failures are
   * logged, never thrown to the writer.
   */
  purgeInterval?: string | number | false
  /** Receives purge failures. */
  logger?: { error?: (...args: unknown[]) => void }
}

/** One write inside a batch: `value === undefined` deletes the path. */
interface PathWrite {
  rest: string[]
  value: unknown
}

const byNamespaceThenKey = (a: UserDataEntry, b: UserDataEntry): number =>
  a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0

function resolveTtl(ttl: string | number | undefined): number | undefined {
  if (ttl === undefined) return undefined
  let ms: number
  try {
    ms = typeof ttl === 'number' ? ttl : parseDuration(ttl)
  } catch (cause) {
    throw new UserDataError('INVALID_TTL', `Invalid user data ttl ${JSON.stringify(ttl)}: use e.g. '30m', '7d' or milliseconds`, { cause })
  }
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new UserDataError('INVALID_TTL', `Invalid user data ttl ${String(ttl)}: it must be a positive, finite duration`)
  }
  // Stores persist the expiry as an integer epoch (BIGINT columns, Redis PX):
  // round sub-millisecond ttls up, and refuse ones whose expiry would not be a
  // safe integer (~285,000 years — omit `ttl` for a permanent key instead).
  ms = Math.ceil(ms)
  if (ms > Number.MAX_SAFE_INTEGER - Date.now()) {
    throw new UserDataError('INVALID_TTL', `Invalid user data ttl ${String(ttl)}: too large (omit ttl for a permanent key)`)
  }
  return ms
}

/**
 * `Promise.all` that waits for EVERY promise to settle before rejecting with
 * the first failure, so no store call is still running once the caller — and
 * the user's lock — moves on.
 */
async function settleAll<T>(promises: ReadonlyArray<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(promises)
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  return results.map((result) => (result as PromiseFulfilledResult<T>).value)
}

/** The single store call that persists one top-level key of a batch. */
type KeyWrite = { kind: 'set'; entry: UserDataEntry } | { kind: 'delete'; key: string }

/**
 * Fold every write targeting ONE top-level key over its `current` entry, in
 * memory. Returns the store call that persists the result, or `undefined` when
 * nothing changes. Throws `UserDataError('INVALID_PATH')` for an array index
 * that would leave a hole — before the batch writes anything.
 */
function planKey(
  userId: UserId,
  namespace: string,
  key: string,
  writes: readonly PathWrite[],
  current: UserDataEntry | undefined,
  ttlMs: number | undefined,
  now: number,
): KeyWrite | undefined {
  let exists = current !== undefined
  let value = current?.value
  let replaced = false
  let changed = false
  for (const write of writes) {
    if (write.rest.length === 0) {
      replaced = true
      changed = true
      exists = write.value !== undefined
      value = write.value
    } else if (write.value === undefined) {
      if (exists && unsetAt(value, write.rest)) changed = true
    } else {
      value = setAt(exists ? value : undefined, write.rest, write.value)
      exists = true
      changed = true
    }
  }
  if (!changed) return undefined
  if (!exists) return { kind: 'delete', key }
  const expiresAt = ttlMs !== undefined
    ? Math.min(now + ttlMs, Number.MAX_SAFE_INTEGER) // resolveTtl checked the bound a few ms earlier
    : replaced ? undefined : current?.expiresAt
  const entry: UserDataEntry = { userId, namespace, key, value, updatedAt: now }
  if (expiresAt !== undefined) entry.expiresAt = expiresAt
  return { kind: 'set', entry }
}

export class UserDataService {
  /** Per-user write queue: every write of one subject runs in call order. */
  private readonly locks = new KeyedQueue()
  private readonly purgeIntervalMs: number | false
  private lastPurgeAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly store: IStore,
    private readonly options: UserDataServiceOptions = {},
  ) {
    const interval = options.purgeInterval
    if (interval === false) {
      this.purgeIntervalMs = false
    } else {
      let ms: number
      try {
        ms = interval === undefined ? DEFAULT_PURGE_INTERVAL_MS : parseDuration(interval)
      } catch (cause) {
        throw new UserDataError('INVALID_TTL', `Invalid purgeInterval ${JSON.stringify(interval)}`, { cause })
      }
      if (!Number.isFinite(ms) || ms < 0) throw new UserDataError('INVALID_TTL', 'purgeInterval must be a non-negative duration')
      this.purgeIntervalMs = ms
    }
  }

  /** Whether the underlying store implements the user-data contract. */
  get supported(): boolean {
    return supportsUserData(this.store)
  }

  /**
   * Profile handle for `userId` in `namespace` (default `'default'`). Cheap —
   * build one per use. Throws `UserDataError('INVALID_NAMESPACE')`
   * synchronously; every other problem rejects the returned methods.
   */
  for(userId: UserId, namespace: string = DEFAULT_USER_NAMESPACE): UserData {
    assertNamespace(namespace)
    return {
      userId,
      namespace,
      get: async <T = unknown>(path: string): Promise<T | undefined> => {
        const [key, ...rest] = parsePath(path)
        const store = this.requireStore(userId)
        const entry = await store.getUserData(userId, namespace, key)
        if (!entry) return undefined
        return (rest.length ? getAt(entry.value, rest) : entry.value) as T | undefined
      },
      all: async (): Promise<Record<string, unknown>> => {
        const store = this.requireStore(userId)
        const entries = (await store.listUserData(userId, namespace)).sort(byNamespaceThenKey)
        return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
      },
      set: async (path: string, value: unknown, options?: UserSetOptions): Promise<void> => {
        const [key, ...rest] = parsePath(path)
        const ttlMs = resolveTtl(options?.ttl)
        const json = value === undefined ? undefined : toJsonValue(value)
        await this.write(userId, namespace, new Map([[key, [{ rest, value: json }]]]), ttlMs)
      },
      update: async (values: Record<string, unknown>, options?: UserSetOptions): Promise<void> => {
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          throw new UserDataError('INVALID_VALUE', 'update() expects a plain object of path → value')
        }
        const ttlMs = resolveTtl(options?.ttl)
        const groups = new Map<string, PathWrite[]>()
        for (const [path, value] of Object.entries(values)) {
          const [key, ...rest] = parsePath(path)
          const json = value === undefined ? undefined : toJsonValue(value)
          const group = groups.get(key) ?? []
          group.push({ rest, value: json })
          groups.set(key, group)
        }
        if (groups.size === 0) return
        await this.write(userId, namespace, groups, ttlMs)
      },
      delete: async (path: string): Promise<void> => {
        const [key, ...rest] = parsePath(path)
        await this.write(userId, namespace, new Map([[key, [{ rest, value: undefined }]]]), undefined)
      },
      clear: async (): Promise<void> => {
        const store = this.requireStore(userId)
        await this.locks.run(userId, () => store.deleteUserData(userId, namespace))
      },
      ns: (name: string): UserData => this.for(userId, name),
    }
  }

  /**
   * Every live entry of `userId` across all namespaces, sorted by namespace
   * then key (subject-data export). `[]` when the store lacks user data.
   */
  async list(userId: UserId): Promise<UserDataEntry[]> {
    if (!supportsUserData(this.store)) return []
    return (await this.store.listUserData(userId)).sort(byNamespaceThenKey)
  }

  /**
   * Erase every namespace of `userId` (subject-data erasure). Queued behind —
   * and therefore after — every write of that user issued before it in this
   * process, so an in-flight write cannot resurrect data afterwards. Resolves
   * with the number of live entries removed; `0` when the store lacks user data.
   */
  async erase(userId: UserId): Promise<number> {
    const store = this.store
    if (!supportsUserData(store)) return 0
    return this.locks.run(userId, async () => {
      const entries = await store.listUserData(userId)
      await store.deleteUserData(userId)
      return entries.length
    })
  }

  /**
   * Physically remove expired entries store-wide (all users, all bots sharing
   * the backend — they are logically gone already). Resolves with the count;
   * `0` for stores with native expiry or without user-data support.
   */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    if (typeof this.store.purgeExpiredUserData !== 'function') return 0
    this.lastPurgeAt = now
    return this.store.purgeExpiredUserData(now)
  }

  /* Internals ------------------------------------------------------------- */

  private requireStore(userId: UserId): UserDataStore {
    assertUserId(userId)
    if (!supportsUserData(this.store)) {
      throw new UserDataError(
        'UNSUPPORTED_STORE',
        'ctx.user requires a store implementing getUserData/setUserData/deleteUserData/listUserData ' +
          '(MemoryStore and every @botmesh/*-store do)',
      )
    }
    return this.store
  }

  /**
   * Run a batch under the user's lock, then maybe purge. Three phases, so an
   * invalid path writes nothing and a failing store call never releases the
   * lock while sibling calls are still running (which would let a queued
   * write or erasure overlap them):
   *  1. read the current entry of every key with a nested write (a pure
   *     top-level write needs no read, so it stays one atomic upsert/delete);
   *  2. fold the writes of every key in memory — path errors throw here,
   *     before anything is written;
   *  3. persist one store call per changed key, and settle ALL of them before
   *     rejecting with the first failure (keys are independent writes, so a
   *     store error can leave the batch partially applied).
   */
  private async write(userId: UserId, namespace: string, groups: Map<string, PathWrite[]>, ttlMs: number | undefined): Promise<void> {
    const store = this.requireStore(userId)
    await this.locks.run(userId, async () => {
      const keys = [...groups]
      const current = await settleAll(keys.map(async ([key, writes]) =>
        writes.some((write) => write.rest.length > 0) ? store.getUserData(userId, namespace, key) : undefined,
      ))
      const now = Date.now()
      const planned = keys.map(([key, writes], i) => planKey(userId, namespace, key, writes, current[i], ttlMs, now))
      await settleAll(planned.map(async (op) => {
        if (op?.kind === 'set') await store.setUserData(op.entry)
        else if (op?.kind === 'delete') await store.deleteUserData(userId, namespace, op.key)
      }))
    })
    await this.maybePurge()
  }

  private async maybePurge(): Promise<void> {
    if (this.purgeIntervalMs === false || typeof this.store.purgeExpiredUserData !== 'function') return
    const now = Date.now()
    if (now - this.lastPurgeAt < this.purgeIntervalMs) return
    this.lastPurgeAt = now
    try {
      await this.store.purgeExpiredUserData(now)
    } catch (err) {
      this.options.logger?.error?.({ err }, 'user data purge failed')
    }
  }
}

function isUserData(value: unknown): value is UserData {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof UserData, unknown>>
  return typeof candidate.get === 'function' && typeof candidate.set === 'function' && typeof candidate.ns === 'function'
}

/**
 * `ctx.user` with a non-optional type — for flows and conversations, whose
 * `ctx` is typed as the minimal {@link RuntimeMessage}. Throws
 * `UserDataError('UNAVAILABLE')` when the context was not built by a Bot.
 *
 * @example
 * ```ts
 * flow('idioma')
 *   .ask('¿Idioma?', 'lang')
 *   .do(async (ctx, c) => { await userOf(ctx).set('lang', c.state.lang) })
 * ```
 */
export function userOf(ctx: RuntimeMessage): UserData {
  const user = (ctx as { user?: unknown }).user
  if (isUserData(user)) return user
  throw new UserDataError('UNAVAILABLE', 'This context has no ctx.user — it was not built by a Bot')
}

/**
 * Placeholder profile for contexts built without a Bot (a bare
 * `buildMessageContext` call): every method rejects with
 * `UserDataError('UNAVAILABLE')`.
 */
export function unavailableUserData(userId: UserId, namespace: string = DEFAULT_USER_NAMESPACE): UserData {
  const fail = async (): Promise<never> => {
    throw new UserDataError('UNAVAILABLE', 'ctx.user is unavailable: this context was not built by a Bot with a user-data capable store')
  }
  return {
    userId,
    namespace,
    get: fail,
    all: fail,
    set: fail,
    update: fail,
    delete: fail,
    clear: fail,
    ns: (name: string): UserData => {
      assertNamespace(name)
      return unavailableUserData(userId, name)
    },
  }
}
