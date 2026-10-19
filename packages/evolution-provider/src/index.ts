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
// Shared with @bot-wa/wppconnect through the private @bot-wa/wa-gateway-kit.
export { WaIdentityStore, normalizeJid } from '@bot-wa/wa-gateway-kit'
export type { IdentityPersistence } from '@bot-wa/wa-gateway-kit'
export { verifyHs256Jwt, signHs256Jwt } from './webhookAuth.js'
export type { RestHttpOptions } from '@bot-wa/wa-gateway-kit'
export type {
  EvolutionProviderConfig,
  EvolutionWebhook,
  EvolutionMessage,
  EvolutionMessageKey,
  EvolutionContextInfo,
  EvolutionMediaToken,
} from './types.js'
