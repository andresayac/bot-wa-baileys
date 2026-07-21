/**
 * @bot-wa/messenger — Facebook Messenger (Meta Graph Send API) transport for
 * @bot-wa/core. Webhook-based, postback buttons, generic-template lists,
 * typing indicators and read receipts.
 */

export { MessengerProvider, toProviderError } from './MessengerProvider.js'
export { toOutbound } from './toOutbound.js'
export { parseInbound } from './parseInbound.js'
export type { PageWebhookBody, MessagingEvent, MessengerMessage, MessengerAttachment } from './parseInbound.js'
export { verifyChallenge, verifySignature } from './webhook.js'
export type { ChallengeQuery } from './webhook.js'
export type { MessengerProviderConfig, GraphErrorBody, MessengerSendResponse } from './types.js'
