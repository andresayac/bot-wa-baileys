/**
 * @bot-wa/wppconnect — wppconnect-server (WA-JS REST gateway) transport for
 * @bot-wa/core. REST outbound (Bearer token) + token-checked webhook ingest,
 * LID/PN identity reconciliation, media download, typed errors.
 */

export { WPPConnectProvider, toWppError } from './WPPConnectProvider.js'
export { parseWebhook, parseMessage, serializedId, jidOf, remoteOfMessageId, lidsIn } from './parseInbound.js'
export type { ParseContext } from './parseInbound.js'
export { toOutbound, target, numberedMenu } from './toOutbound.js'
export type { WppOutbound } from './toOutbound.js'
// Shared with @bot-wa/evolution through the private @bot-wa/wa-gateway-kit.
export { WaIdentityStore, normalizeJid } from '@bot-wa/wa-gateway-kit'
export type { IdentityPersistence, RestHttpOptions } from '@bot-wa/wa-gateway-kit'
export type { WPPConnectProviderConfig, WppMessage, WppSender, WppId, WppMediaToken } from './types.js'
