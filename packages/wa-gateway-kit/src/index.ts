/**
 * @bot-wa/wa-gateway-kit — internal building blocks shared by the WhatsApp
 * REST gateway transports (@bot-wa/evolution, @bot-wa/wppconnect). Private:
 * never published; each provider re-exports the public pieces it documents.
 */

export {
  restCall,
  resolveHttpPolicy,
  parseRetryAfter,
  isRecord,
  describeErrorBody,
} from './rest.js'
export type { RestHttpOptions, RestResponse } from './rest.js'
export { resolveMedia, guessMimetype, toDataUri } from './media.js'
export type { ResolvedMedia } from './media.js'
export { WaIdentityStore, normalizeJid, isLidJid, isGroupJid } from './identity.js'
export type { IdentityPersistence } from './identity.js'
