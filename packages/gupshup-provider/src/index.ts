/**
 * @bot-wa/gupshup — Gupshup WhatsApp transport for @bot-wa/core: v1 send API
 * (text, media, quick replies, lists, templates) and v2 callbacks
 * authenticated by a shared webhook token.
 */

export { GupshupProvider } from './GupshupProvider.js'
export type { GupshupIngestRequest } from './GupshupProvider.js'
export { GupshupApiError, toGupshupError } from './errors.js'
export { parseInbound } from './parseInbound.js'
export { toOutbound, mediaUrlOf } from './toOutbound.js'
export type { GupshupOutbound } from './toOutbound.js'
export type { ProviderHttpOptions } from './http.js'
export type {
  GupshupProviderConfig,
  GupshupCallback,
  GupshupMessagePayload,
  GupshupEventPayload,
  GupshupSender,
  GupshupSendResponse,
} from './types.js'
