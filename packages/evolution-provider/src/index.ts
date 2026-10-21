/**
 * @botmesh/evolution — Evolution API v2 transport for @botmesh/core.
 * REST outbound (apikey) + authenticated webhook ingest, LID/PN identity
 * reconciliation, media download, typed errors.
 */

export { EvolutionProvider, toEvolutionError } from './EvolutionProvider.js'
export { parseWebhook, parseMessage, normalizeEventName, textOf } from './parseInbound.js'
export type { ParseContext } from './parseInbound.js'
export { toOutbound, keyFromRef, numberedMenu } from './toOutbound.js'
export type { EvolutionOutbound } from './toOutbound.js'
// Shared with @botmesh/wppconnect through the private @botmesh/wa-gateway-kit.
export { WaIdentityStore, normalizeJid } from '@botmesh/wa-gateway-kit'
export type { IdentityPersistence } from '@botmesh/wa-gateway-kit'
export { verifyHs256Jwt, signHs256Jwt } from './webhookAuth.js'
export type { RestHttpOptions } from '@botmesh/wa-gateway-kit'
export type {
  EvolutionProviderConfig,
  EvolutionWebhook,
  EvolutionMessage,
  EvolutionMessageKey,
  EvolutionContextInfo,
  EvolutionMediaToken,
} from './types.js'
