/**
 * @botmesh/gohighlevel — HighLevel (LeadConnector) Conversations API transport
 * for @botmesh/core: SMS, WhatsApp, Email, FB, IG and Live chat through one
 * CRM contact, with Ed25519-signed (`X-GHL-Signature`) webhooks.
 */

export { GoHighLevelProvider } from './GoHighLevelProvider.js'
export { GoHighLevelApiError, toGhlError } from './errors.js'
export { GHL_WEBHOOK_PUBLIC_KEY, verifyGhlSignature } from './signature.js'
export type { GhlSignatureResult, VerifyGhlInput } from './signature.js'
export { parseInbound, channelOf, attachmentKind } from './parseInbound.js'
export type { ParsedGhl } from './parseInbound.js'
export { toOutbound, mediaUrlOf } from './toOutbound.js'
export type { GhlOutboundFields } from './toOutbound.js'
export type { ProviderHttpOptions } from './http.js'
export type { GoHighLevelProviderConfig, GhlChannel, GhlWebhookBody, GhlSendResponse, GhlErrorBody } from './types.js'
