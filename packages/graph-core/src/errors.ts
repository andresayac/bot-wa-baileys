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
} from '@botmesh/core'

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

/**
 * Messenger Platform (Messenger + Instagram DM) send failures, keyed by subcode:
 *  - outside the messaging window: code 10 with subcode 2018278 (Messenger) or
 *    2534022 (Instagram) -> {@link OutsideSessionWindowError};
 *  - recipient gone / unknown: code 551 ("This person isn't available right
 *    now"), subcodes 1545041, 2018001 and 2534014 ("No matching user found")
 *    -> {@link RecipientUnreachableError}.
 */
const WINDOW_SUBCODES = new Set([2018278, 2534022])
const UNREACHABLE_SUBCODES = new Set([1545041, 2018001, 2534014])

/** Translate a Graph error into the core's typed provider error. */
export function toGraphError(err: GraphError, opts: GraphErrorOptions = {}): ProviderError {
  const code = err.code
  const subcode = err.error_subcode
  const msg = err.message ?? 'Graph API error'
  const chatId = opts.chatId ?? ''
  // Subcodes are more specific than codes (the window error is a plain code 10),
  // so they are checked first.
  if (subcode !== undefined) {
    const tag = `${code ?? '?'}/${subcode}`
    if (WINDOW_SUBCODES.has(subcode)) {
      return new OutsideSessionWindowError(chatId, `${msg} (${tag}) — the user must write first (24h window) or use a message tag.`)
    }
    if (UNREACHABLE_SUBCODES.has(subcode)) return new RecipientUnreachableError(chatId, `${msg} (${tag})`)
  }
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
    case 551:    // Messenger Platform: "This person isn't available right now"
      return new RecipientUnreachableError(chatId, `${msg} (551${subcode ? `/${subcode}` : ''})`)
    // Code 10 (permission denied) is only a window error with a window subcode,
    // handled above; a bare code 10 falls through to the generic error.
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

/** The subset of a fetch `Response` that {@link readGraphResponse} reads. */
export interface GraphResponseLike {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

/**
 * Read a Graph API response: resolve to its JSON body (an unparsable body is
 * `{}`), or reject with the typed error {@link toGraphError} maps it to when the
 * HTTP status fails or the body carries an `error` object. A `Retry-After`
 * header (seconds) overrides `opts.retryAfterMs`.
 *
 * This is the single response check shared by the WhatsApp Cloud API,
 * Messenger and Instagram clients, so the Messenger Platform window /
 * unreachable codes are mapped in exactly one place.
 */
export async function readGraphResponse<T = unknown>(res: GraphResponseLike, opts: GraphErrorOptions = {}): Promise<T> {
  const parsed = await res.json().catch(() => ({}))
  const body = (parsed && typeof parsed === 'object' ? parsed : {}) as { error?: GraphError }
  if (!res.ok || body.error) {
    const retryAfter = Number(res.headers.get('Retry-After')) || undefined
    throw toGraphError(body.error ?? { message: `HTTP ${res.status}` }, {
      ...opts,
      retryAfterMs: retryAfter ? retryAfter * 1000 : opts.retryAfterMs,
    })
  }
  return body as T
}
