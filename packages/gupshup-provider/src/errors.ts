/** Gupshup REST error → typed `ProviderError` mapping. */

import {
  OutsideSessionWindowError,
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
} from '@bot-wa/core'

/** Any Gupshup failure not mapped to a more specific class. */
export class GupshupApiError extends ProviderError {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GupshupApiError'
  }
}

const OUTSIDE_WINDOW = /24 ?hours|session (window|expired)|re-?engagement|outside.*window/i
const UNREACHABLE = /opted?[ -]?(in|out)|not opted|inactive|invalid (destination|phone|number)|not a (valid )?whatsapp|blocked/i
const TOO_LARGE = /too (long|large)|exceeds?|size limit/i

export function toGupshupError(status: number, detail: string | undefined, chatId: string, retryAfter?: number): ProviderError {
  const text = detail ?? 'request failed'
  const message = `Gupshup HTTP ${status}: ${text}`
  if (status === 429 || /rate limit|too many requests/i.test(text)) return new RateLimitedError(retryAfter ?? 1000, message)
  if (OUTSIDE_WINDOW.test(text)) return new OutsideSessionWindowError(chatId, message)
  if (UNREACHABLE.test(text)) return new RecipientUnreachableError(chatId, message)
  if (status === 413 || TOO_LARGE.test(text)) return new PayloadTooLargeError(message)
  return new GupshupApiError(message, status)
}
