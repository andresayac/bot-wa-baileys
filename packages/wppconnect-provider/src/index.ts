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
export { WaIdentityStore, normalizeJid } from './identity.js'
export type { RestHttpOptions } from './rest.js'
export type { WPPConnectProviderConfig, WppMessage, WppSender, WppId, WppMediaToken } from './types.js'
