/**
 * @bot-wa/meta — WhatsApp Cloud API (official Meta) transport for @bot-wa/core.
 * Webhook-based, no ban risk, native buttons/lists/templates.
 */

export { CloudAPIProvider } from './CloudAPIProvider.js'
export { GraphClient, toProviderError } from './graphClient.js'
export { toOutbound } from './toOutbound.js'
export type { ResolvedMedia } from './toOutbound.js'
export { parseInbound } from './parseInbound.js'
export type {
  GraphWebhookBody,
  GraphValue,
  GraphMessage,
  GraphStatus,
  GraphContact,
  GraphMedia,
  GraphUserIdUpdate,
  ParseInboundOptions,
} from './parseInbound.js'
export { MemoryIdentityMap, isBsuid } from './identity.js'
export type { IdentityMap, IdentityLogger, MemoryIdentityMapOptions, MaybePromise } from './identity.js'
export { verifyChallenge, verifySignature } from '@bot-wa/graph-core'
export type { ChallengeQuery } from '@bot-wa/graph-core'
export type { CloudAPIProviderConfig, GraphErrorBody, GraphSendMessageResponse } from './types.js'
