/**
 * Reconnect policy — pure decision logic for connection-close handling.
 *
 * Extracted from BaileysProvider so it can be unit-tested without a socket.
 * Maps a Baileys {@link DisconnectReason} status code to the action the
 * provider should take, and computes the backoff delay between attempts.
 */

import { DisconnectReason } from '@whiskeysockets/baileys'

export type DisconnectAction =
  /** Session is invalid — wipe auth state and start fresh. */
  | 'wipe'
  /** Do NOT reconnect — another client owns the session, or we're forbidden. */
  | 'stop'
  /** Reconnect immediately (normal post-pairing restart). */
  | 'reconnect-now'
  /** Reconnect after an exponential backoff delay. */
  | 'reconnect-backoff'

/**
 * Decide what to do when the socket closes, from the disconnect status code.
 *
 * - `loggedOut` / `badSession` / `multideviceMismatch` → `wipe`
 * - `connectionReplaced` (440, "conflict": another device/instance took the
 *   session) / `forbidden` (403) → `stop` — reconnecting just fights the other
 *   client forever and risks a ban
 * - `restartRequired` (515) → `reconnect-now` (expected during pairing)
 * - everything else (timeouts, transient closes, service unavailable) →
 *   `reconnect-backoff`
 */
export function classifyDisconnect(statusCode: number | undefined): DisconnectAction {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
    case DisconnectReason.badSession:
    case DisconnectReason.multideviceMismatch:
      return 'wipe'
    case DisconnectReason.connectionReplaced:
    case DisconnectReason.forbidden:
      return 'stop'
    case DisconnectReason.restartRequired:
      return 'reconnect-now'
    default:
      return 'reconnect-backoff'
  }
}

/**
 * Exponential backoff with a cap. `attempt` is 0-based (first retry = 0).
 *
 * @example
 * ```ts
 * backoffDelay(0) // 1000
 * backoffDelay(1) // 2000
 * backoffDelay(5) // 30000 (capped)
 * ```
 */
export function backoffDelay(attempt: number, base = 1000, cap = 30_000): number {
  if (attempt < 0) attempt = 0
  return Math.min(base * 2 ** attempt, cap)
}

/** Max consecutive backoff reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 10
