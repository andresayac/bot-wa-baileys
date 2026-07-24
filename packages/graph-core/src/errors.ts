/**
 * Unified Meta Graph error mapping. A single superset that covers WhatsApp Cloud
 * API business codes AND the generic Facebook/Instagram rate-limit codes, so all
 * three transports share one (complete) mapping instead of three divergent ones.
 */

import {
  ProviderError,
  OutsideSessionWindowError,
  RecipientUnreachableError,
  RateLimitedError,
  UnsupportedContentError,
  type ChatId,
} from '@bot-wa/core'

export interface GraphError {
  code?: number
  message?: string
  error_subcode?: number
}

export interface GraphErrorOptions {
  /** The recipient the failing call targeted — enriches window/unreachable errors. */
  chatId?: ChatId
  /** Server-signalled retry delay in ms (from a Retry-After header). */
  retryAfterMs?: number
}

/** Translate a Graph error into the core's typed provider error. */
export function toGraphError(err: GraphError, opts: GraphErrorOptions = {}): ProviderError {
  const code = err.code
  const msg = err.message ?? 'Graph API error'
  const chatId = opts.chatId ?? ''
  switch (code) {
    case 131047: // re-engagement: outside the 24h free-form window (WhatsApp)
      return new OutsideSessionWindowError(chatId, `${msg} (131047) — send a template (kind template).`)
    case 131026: // message undeliverable (recipient can't receive)
      return new RecipientUnreachableError(chatId, `${msg} (131026)`)
    case 131051: // unsupported message type
      return new UnsupportedContentError('native', `${msg} (131051)`)
    case 4:      // app-level rate limit
    case 613:    // calls to this API have exceeded the rate limit
    case 80007:  // account-level rate limit
    case 36003:  // business rate limit
      return new RateLimitedError(opts.retryAfterMs ?? 60_000, `${msg} (${code})`)
    default:
      return new ProviderError(`${msg}${code ? ` (code ${code})` : ''}`)
  }
}
