/**
 * @bot-wa/evolution — Evolution API v2 transport for @bot-wa/core.
 * REST outbound (apikey) + authenticated webhook ingest, LID/PN identity
 * reconciliation, media download, typed errors.
 */

export { EvolutionProvider, toEvolutionError } from './EvolutionProvider.js'
export { parseWebhook, parseMessage, normalizeEventName, textOf } from './parseInbound.js'
export type { ParseContext } from './parseInbound.js'
export { toOutbound, keyFromRef, numberedMenu } from './toOutbound.js'
export type { EvolutionOutbound } from './toOutbound.js'
export { WaIdentityStore, normalizeJid } from './identity.js'
export type { IdentityPersistence } from './identity.js'
export { verifyHs256Jwt, signHs256Jwt } from './webhookAuth.js'
export type { RestHttpOptions } from './rest.js'
export type {
  EvolutionProviderConfig,
  EvolutionWebhook,
  EvolutionMessage,
  EvolutionMessageKey,
  EvolutionContextInfo,
  EvolutionMediaToken,
} from './types.js'
