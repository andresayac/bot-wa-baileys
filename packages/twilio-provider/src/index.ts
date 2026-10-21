/**
 * @botmesh/twilio — Twilio Programmable Messaging transport for @botmesh/core:
 * WhatsApp + SMS/MMS over the REST API, webhooks verified with X-Twilio-Signature.
 */

export { TwilioProvider, TWILIO_MAX_BODY } from './TwilioProvider.js'
export type { TwilioIngestRequest } from './TwilioProvider.js'
export { TwilioApiError, toTwilioError } from './errors.js'
export { computeTwilioSignature, verifyTwilioSignature, parseFormParams } from './signature.js'
export type { TwilioParams, VerifyTwilioInput } from './signature.js'
export { parseInbound, channelOf } from './parseInbound.js'
export type { ParsedTwilio } from './parseInbound.js'
export { toOutbound, mediaUrlOf } from './toOutbound.js'
export type { TwilioOutboundParams } from './toOutbound.js'
export type { ProviderHttpOptions } from './http.js'
export type { TwilioProviderConfig, TwilioErrorBody, TwilioMessageResource, TwilioWebhookParams } from './types.js'
