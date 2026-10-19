/**
 * @bot-wa/instagram — Instagram DM (Messenger API for Instagram) transport for
 * @bot-wa/core. Webhook-based: DMs arrive on the 'page' webhook object of the
 * connected Facebook Page; sending goes through the Graph Send API.
 */

export { InstagramProvider } from './InstagramProvider.js'
export { GraphClient, toProviderError } from './graphClient.js'
export { toOutbound } from './toOutbound.js'
export { parseInbound } from './parseInbound.js'
export type { IgWebhookBody, IgMessagingEvent } from './parseInbound.js'
export { verifyChallenge, verifySignature } from '@bot-wa/graph-core'
export type { ChallengeQuery } from '@bot-wa/graph-core'
export type { InstagramProviderConfig, GraphSendResponse } from './types.js'
