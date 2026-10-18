/** HighLevel REST error → typed `ProviderError` mapping. */

import { PayloadTooLargeError, ProviderError, RateLimitedError, RecipientUnreachableError } from '@bot-wa/core'
import type { GhlErrorBody } from './types.js'

/** Any HighLevel API failure not mapped to a more specific class. */
export class GoHighLevelApiError extends ProviderError {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GoHighLevelApiError'
  }
}

function messageOf(body: GhlErrorBody): string {
  if (Array.isArray(body.message)) return body.message.join('; ')
  return body.message ?? body.error ?? 'request failed'
}

/** Opt-out / DND / unknown-contact wording HighLevel returns on 400/422. */
const UNREACHABLE_HINT = /\b(dnd|do not disturb|opted? ?out|unsubscribed|contact not found|no phone|invalid (phone|number|email))\b/i

export function toGhlError(status: number, body: GhlErrorBody, chatId: string, retryAfter?: number): ProviderError {
  const detail = messageOf(body)
  const message = `HighLevel HTTP ${status}: ${detail}`
  if (status === 429) return new RateLimitedError(retryAfter ?? 10_000, message)
  if (status === 413) return new PayloadTooLargeError(message)
  if (status === 404 || ((status === 400 || status === 422) && UNREACHABLE_HINT.test(detail))) {
    return new RecipientUnreachableError(chatId, message)
  }
  return new GoHighLevelApiError(message, status)
}
