/**
 * Typed errors raised by the `ctx.user` profile API.
 */

/** Machine-readable reason carried by {@link UserDataError}. */
export type UserDataErrorCode =
  /** Empty path, empty segment (`a..b`), control characters, `__proto__`/`prototype`/`constructor`, key > 255 chars, or an array index that would leave a hole. */
  | 'INVALID_PATH'
  /** Empty namespace, longer than 128 chars, or containing control characters. */
  | 'INVALID_NAMESPACE'
  /** Value that cannot be stored as JSON (BigInt, function, symbol, circular structure). */
  | 'INVALID_VALUE'
  /** TTL that is not a positive, finite duration (`'30m'`, `'7d'`, milliseconds), or so large the expiry would exceed `Number.MAX_SAFE_INTEGER`. */
  | 'INVALID_TTL'
  /** Empty or non-string subject id. */
  | 'INVALID_USER'
  /** The configured store does not implement the optional user-data methods of `IStore`. */
  | 'UNSUPPORTED_STORE'
  /** The context was not built by a `Bot` (e.g. a hand-made `buildMessageContext` call or a plain object). */
  | 'UNAVAILABLE'

/**
 * Error thrown (or rejected) by every `ctx.user` / `bot.user()` operation on
 * invalid input or when user data is not available. Inspect `code` rather than
 * the message.
 *
 * @example
 * ```ts
 * try { await ctx.user.set('a..b', 1) }
 * catch (error) {
 *   if (error instanceof UserDataError && error.code === 'INVALID_PATH') { ... }
 * }
 * ```
 */
export class UserDataError extends Error {
  constructor(
    readonly code: UserDataErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'UserDataError'
  }
}
