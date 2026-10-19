/**
 * @bot-wa/messenger — Facebook Messenger (Meta Graph Send API) transport for
 * @bot-wa/core. Webhook-based, postback buttons, generic-template lists,
 * typing indicators and read receipts.
 */

export { MessengerProvider, toProviderError } from './MessengerProvider.js'
export { toOutbound, toOutboundMessages } from './toOutbound.js'
export { parseInbound } from './parseInbound.js'
export type { PageWebhookBody, MessagingEvent, MessengerMessage, MessengerAttachment } from './parseInbound.js'
export { verifyChallenge, verifySignature } from '@bot-wa/graph-core'
export type { ChallengeQuery } from '@bot-wa/graph-core'
export type { MessengerProviderConfig, MessengerSendResponse } from './types.js'
