/**
 * Public types of the persistent per-user profile (`ctx.user`, FEATURES.md #1).
 */

import type { UserId } from '../core/provider.js'

/** Options for {@link UserData.set} and {@link UserData.update}. */
export interface UserSetOptions {
  /**
   * Time-to-live of the TOP-LEVEL key being written: a duration string accepted
   * by `parseDuration` (`'90s'`, `'30m'`, `'12h'`, `'7d'`, `'2w'`) or
   * milliseconds. Must be positive and finite, and small enough that the
   * expiry stays a safe-integer epoch (about 285,000 years; omit `ttl` for a
   * permanent key), otherwise the call rejects with
   * `UserDataError('INVALID_TTL')`. Fractional milliseconds are rounded up, so
   * every store receives an integer expiry.
   *
   * Expiry rules (same model as Redis `SET` vs. a partial update):
   *  - **with `ttl`** — the top-level key expires `ttl` after this write, even
   *    when the path is nested (`set('board.turn', 'x', { ttl: '30m' })`
   *    re-arms the expiry of `board`);
   *  - **top-level write without `ttl`** (`set('board', …)`) replaces the value
   *    AND clears any previous expiry — the key becomes permanent;
   *  - **nested write without `ttl`** (`set('board.turn', …)`, `delete('board.turn')`)
   *    keeps the current expiry of the top-level key.
   *
   * An expired key reads as absent immediately; stores remove it physically
   * later (Redis natively, the others through `purgeExpiredUserData`).
   */
  ttl?: string | number
}

/**
 * Persistent, per-user key/value profile — `ctx.user` in handlers and
 * `bot.user(userId)` anywhere else.
 *
 * **Scope.** Keyed by the canonical sender (`ctx.sender`, the provider-resolved
 * `senderId`), so it is shared across every chat that person writes from (DM
 * and groups) and survives conversations and restarts (with a persistent
 * store). It lives inside the bot's store namespace (tenant / environment /
 * bot / provider / connection), so two bots sharing one backend never see each
 * other's profiles.
 *
 * **Namespaces.** `ctx.user` is the `'default'` namespace; `ctx.user.ns('game')`
 * returns the same API scoped to `'game'`. Namespace names are flat and
 * absolute (`ctx.user.ns('a').ns('b')` is namespace `'b'`). Use one per
 * feature/plugin to avoid key collisions.
 *
 * **Paths.** Every method takes a dot path: `'name'`, `'address.city'`,
 * `'items.0'`. The FIRST segment is the top-level key, which is the unit the
 * store persists atomically; deeper segments are resolved inside its JSON value
 * (array elements by index). Keys cannot contain dots; `__proto__`,
 * `prototype`, `constructor`, empty segments and control characters are
 * rejected with `UserDataError('INVALID_PATH')`.
 *
 * **Values** are JSON data: they are deep-copied through JSON on write (a
 * `Date` becomes its ISO string, `undefined` members vanish) and every read
 * returns a fresh copy. BigInt, functions, symbols and cycles reject with
 * `UserDataError('INVALID_VALUE')`. Writing `undefined` deletes the path.
 *
 * **Concurrency.** The dispatcher's per-chat FIFO does NOT serialise one user
 * across several chats (the same person can be handled in a group and in a DM
 * at the same time), so the profile serialises writes itself: inside one
 * process, every write of a user (`set` / `update` / `delete` / `clear` and the
 * bot's subject erasure) runs in call order, one at a time. A top-level
 * `set`/`delete` is a single atomic store write; a nested write is a
 * read-modify-write of its top-level key. Across several bot replicas sharing a
 * store, top-level writes stay atomic (last writer wins) but two replicas
 * writing nested paths of the SAME top-level key concurrently can lose one
 * update — keep such keys owned by one replica or write whole top-level values.
 * Reads never wait for writes; `await` your writes before reading them back.
 *
 * @example
 * ```ts
 * bot.when('hola', async (ctx) => {
 *   const name = await ctx.user.get<string>('name')
 *   await ctx.user.set('name', 'Juan')
 *   await ctx.user.set('address.city', 'Bogotá')
 *   await ctx.user.update({ lang: 'es', 'address.zip': '110111' })
 *   await ctx.user.ns('game').set('board', board, { ttl: '30m' })
 *   await ctx.user.ns('game').clear()
 * })
 * ```
 */
export interface UserData {
  /** Subject this profile belongs to (`ctx.sender`). */
  readonly userId: UserId
  /** Namespace this handle reads and writes (`'default'` for `ctx.user`). */
  readonly namespace: string

  /**
   * Value at `path`, or `undefined` when missing or expired. `T` is an
   * unchecked convenience cast — validate untrusted shapes yourself.
   */
  get<T = unknown>(path: string): Promise<T | undefined>
  /** Every live top-level key of this namespace as a plain object (`{}` when empty). */
  all(): Promise<Record<string, unknown>>
  /** Write `value` at `path` (see {@link UserSetOptions.ttl} for expiry). `undefined` deletes. */
  set(path: string, value: unknown, options?: UserSetOptions): Promise<void>
  /**
   * Apply several writes: each own enumerable property of `values` is a PATH
   * (`{ name: 'Juan', 'address.city': 'Bogotá' }`), applied in object key
   * order like {@link set}; keys not mentioned are left alone. Paths, values,
   * `ttl` and array indexes (against the stored values) are validated before
   * anything is written, so an invalid batch writes nothing. All paths under
   * one top-level key become a single store write; the batch as a whole is not
   * atomic: each top-level key is its own write, so if the STORE fails one of
   * them the others may already be persisted. The call rejects with the first
   * store error only after every write of the batch has settled, so the next
   * write (or erasure) of this user never overlaps it.
   */
  update(values: Record<string, unknown>, options?: UserSetOptions): Promise<void>
  /** Remove `path` (a top-level key or a nested member). Missing paths are a no-op. */
  delete(path: string): Promise<void>
  /** Remove every key of THIS namespace for this user (other namespaces are untouched). */
  clear(): Promise<void>
  /** Same API scoped to namespace `name`. Throws `UserDataError('INVALID_NAMESPACE')` synchronously. */
  ns(name: string): UserData
}
