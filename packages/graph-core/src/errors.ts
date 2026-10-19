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
  type OutboundContent,
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
  /**
   * The `OutboundContent` kind of the failing send, when the caller knows it.
   * Becomes `UnsupportedContentError.kind` for the "unsupported content" codes
   * (131051, 131062); without it each code falls back to its most likely kind.
   */
  contentKind?: OutboundContent['kind']
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
    case 131030: // recipient not in the test number's allowed list (WhatsApp)
      return new RecipientUnreachableError(
        chatId,
        `${msg} (131030) — add the recipient to the allowed list of your test number, or send from a production number.`,
      )
    case 551:    // this person isn't available right now (Messenger / Instagram)
      return new RecipientUnreachableError(chatId, `${msg} (551)`)
    case 10:     // permission denied; subcode 2018278 = outside the messaging window (Messenger / Instagram)
      if (err.error_subcode === 2018278) {
        return new OutsideSessionWindowError(chatId, `${msg} (10/2018278) — the 24h messaging window is closed; use a message tag.`)
      }
      return new ProviderError(`${msg} (code 10)`)
    case 131051: // unsupported message type
      return new UnsupportedContentError(opts.contentKind ?? 'native', `${msg} (131051)`)
    case 131062: // BSUID recipient not supported for this message (WhatsApp): only the
                 // one-tap / zero-tap / copy-code authentication templates need a phone number
      return new UnsupportedContentError(
        opts.contentKind ?? 'template',
        `${msg} (131062) — send it to the user's phone number (wa_id), not the business-scoped user id.`,
      )
    case 4:      // app-level rate limit
    case 613:    // calls to this API have exceeded the rate limit
    case 80007:  // account-level rate limit
    case 36003:  // business rate limit
      return new RateLimitedError(opts.retryAfterMs ?? 60_000, `${msg} (${code})`)
    case 130429: // WhatsApp Cloud API throughput (messages per second) reached
      return new RateLimitedError(opts.retryAfterMs ?? 1_000, `${msg} (130429)`)
    case 131056: // WhatsApp pair rate limit: too many messages to the same user
      return new RateLimitedError(opts.retryAfterMs ?? 6_000, `${msg} (131056)`)
    case 131048: // WhatsApp spam rate limit: the number's sends are restricted
      return new RateLimitedError(opts.retryAfterMs ?? 60_000, `${msg} (131048)`)
    // 147001-147005 (business-username API: not available, not eligible, FB/IG not
    // linked, transfer required) fall through on purpose: they are account-management
    // failures, not send failures, so no typed send error fits.
    default:
      return new ProviderError(`${msg}${code ? ` (code ${code})` : ''}`)
  }
}
