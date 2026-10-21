/**
 * Twilio REST error → typed `ProviderError` mapping.
 * Error codes: https://www.twilio.com/docs/api/errors
 */

import {
  OutsideSessionWindowError,
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
} from '@botmesh/core'
import type { TwilioErrorBody } from './types.js'

/** Any Twilio REST failure the provider could not map to a more specific class. */
export class TwilioApiError extends ProviderError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly moreInfo?: string,
  ) {
    super(message)
    this.name = 'TwilioApiError'
  }
}

/** Rate limit / queue overflow codes. */
const RATE_LIMIT_CODES = new Set([20429, 14107, 30022, 63018])
/** The recipient cannot be reached (invalid/unsubscribed/unroutable/not on WhatsApp). */
const UNREACHABLE_CODES = new Set([21211, 21408, 21610, 21612, 21614, 63003, 63024])
/** Free-form message outside the WhatsApp 24h customer-service window. */
const OUTSIDE_WINDOW_CODES = new Set([63016])
/** Body or media over a size limit. */
const TOO_LARGE_CODES = new Set([21617, 11751, 30019])

export function toTwilioError(
  status: number,
  body: TwilioErrorBody,
  chatId: string,
  retryAfter?: number,
): ProviderError {
  const code = typeof body.code === 'number' ? body.code : undefined
  const message = `Twilio ${code ?? `HTTP ${status}`}: ${body.message ?? 'request failed'}`
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return new RateLimitedError(retryAfter ?? 1000, message)
  }
  if (code !== undefined && OUTSIDE_WINDOW_CODES.has(code)) return new OutsideSessionWindowError(chatId, message)
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return new RecipientUnreachableError(chatId, message)
  if (status === 413 || (code !== undefined && TOO_LARGE_CODES.has(code))) return new PayloadTooLargeError(message)
  return new TwilioApiError(message, status, code, body.more_info)
}
