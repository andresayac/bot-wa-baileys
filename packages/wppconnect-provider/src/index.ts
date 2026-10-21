/**
 * @botmesh/wppconnect — wppconnect-server (WA-JS REST gateway) transport for
 * @botmesh/core. REST outbound (Bearer token) + token-checked webhook ingest,
 * LID/PN identity reconciliation, media download, typed errors.
 */

export { WPPConnectProvider, toWppError } from './WPPConnectProvider.js'
export { parseWebhook, parseMessage, serializedId, jidOf, remoteOfMessageId, lidsIn } from './parseInbound.js'
export type { ParseContext } from './parseInbound.js'
export { toOutbound, target, numberedMenu } from './toOutbound.js'
export type { WppOutbound } from './toOutbound.js'
// Shared with @botmesh/evolution through the private @botmesh/wa-gateway-kit.
export { WaIdentityStore, normalizeJid } from '@botmesh/wa-gateway-kit'
export type { IdentityPersistence, RestHttpOptions } from '@botmesh/wa-gateway-kit'
export type { WPPConnectProviderConfig, WppMessage, WppSender, WppId, WppMediaToken } from './types.js'
