/**
 * TikTok API for Business error mapping. A call fails when the HTTP status is
 * not 2xx OR the envelope `code` is non-zero (TikTok answers HTTP 200 with
 * e.g. `code: 40100`). Codes per the "Return codes" appendix (v1.3).
 */

import {
  OutsideSessionWindowError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  type ChatId,
} from '@bot-wa/core'

/** A TikTok API failure that maps to no more specific {@link ProviderError} subclass. */
export class TikTokApiError extends ProviderError {
  constructor(
    message: string,
    readonly code?: number,
    readonly requestId?: string,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'TikTokApiError'
  }
}

/** Throttling codes: app-level (40016, 40100), advertiser-level (40133), field-level (40132). */
const RATE_LIMIT_CODES = new Set([40016, 40100, 40132, 40133])
/** "The operation/object does not exist" — e.g. an unknown conversation or comment. */
const NOT_FOUND_CODES = new Set([40007])
/** Messaging-limit wording (48 h window / message quota for non-mutual conversations). */
const WINDOW_RE = /48[- ]?hour|messag\w* limit|limit of messages|within \d+ hours|session window|cannot (?:send|initiate)/i

export interface TikTokErrorInput {
  chatId: ChatId
  httpStatus: number
  code?: number
  message?: string
  requestId?: string
  retryAfterMs?: number
}

/** Translate a failed TikTok response into a typed provider error. */
export function toProviderError(input: TikTokErrorInput): ProviderError {
  const { chatId, httpStatus, code, requestId } = input
  const message = input.message || (code !== undefined ? `TikTok error ${code}` : `TikTok HTTP ${httpStatus}`)
  const detail = `${message}${code !== undefined ? ` (code ${code})` : ''}${requestId ? ` [request_id ${requestId}]` : ''}`
  if (httpStatus === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return new RateLimitedError(input.retryAfterMs ?? 1000, detail)
  }
  if (WINDOW_RE.test(message)) return new OutsideSessionWindowError(chatId, detail)
  if (code !== undefined && NOT_FOUND_CODES.has(code)) return new RecipientUnreachableError(chatId, detail)
  return new TikTokApiError(detail, code, requestId, httpStatus)
}
