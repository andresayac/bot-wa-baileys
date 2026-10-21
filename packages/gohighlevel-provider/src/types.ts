/**
 * @botmesh/gohighlevel — configuration and HighLevel (LeadConnector) wire
 * shapes (subset used).
 */

import type { ProviderHttpOptions } from './http.js'
import type { LoggerLike } from '@botmesh/core'

/** Message channels accepted by `POST /conversations/messages` (`type`). */
export type GhlChannel = 'SMS' | 'WhatsApp' | 'Email' | 'IG' | 'FB' | 'Custom' | 'Live_Chat' | 'GMB' | (string & {})

export interface GoHighLevelProviderConfig {
  /** Private Integration Token or OAuth (sub-account / location) access token. Sent as Bearer. */
  accessToken: string
  /**
   * Location (sub-account) id. Webhooks for any other location are dropped, and
   * `markRead` sends it with the conversation update.
   */
  locationId: string
  /** `Version` header for the API. Default `'2021-04-15'` (the Conversations API version). */
  apiVersion?: string
  /** API base URL. Default `'https://services.leadconnectorhq.com'`. */
  baseUrl?: string
  /** Channel used to reply when the chat's channel is unknown (no inbound seen yet). Default `'SMS'`. */
  defaultChannel?: GhlChannel
  /**
   * Ed25519 public key (PEM) that verifies `X-GHL-Signature`. Defaults to
   * HighLevel's published key; override only if HighLevel rotates it.
   */
  publicKey?: string
  /**
   * Legacy RSA public key (PEM) for `X-WH-Signature` (RSA-SHA256). HighLevel
   * stopped sending it on 2026-09-01; leave unset unless you still receive it.
   */
  legacyPublicKey?: string
  /** Explicit local-development escape hatch: accept webhooks without a signature. */
  allowUnsignedWebhooks?: boolean
  /** `secureFetch` options for every outbound request (REST + media). `fetch`/`resolver` are test seams. */
  http?: ProviderHttpOptions
  /** The bot's own id (a HighLevel user id). Optional. */
  selfId?: string
  debug?: boolean
  logger?: LoggerLike
}

/** `InboundMessage` webhook body (and the fields of its siblings we read). */
export interface GhlWebhookBody {
  type?: string
  locationId?: string
  webhookId?: string
  timestamp?: string
  attachments?: string[]
  body?: string
  contactId?: string
  contentType?: string
  conversationId?: string
  conversationProviderId?: string
  dateAdded?: string
  direction?: 'inbound' | 'outbound' | string
  messageType?: string
  messageTypeString?: string
  messageId?: string
  status?: string
  callStatus?: string
  callDuration?: number
  from?: string
  to?: string
  userId?: string
  subject?: string
  threadId?: string
  emailMessageId?: string
  [key: string]: unknown
}

/** Success shape of `POST /conversations/messages`. */
export interface GhlSendResponse {
  conversationId?: string
  messageId?: string
  messageIds?: string[]
  emailMessageId?: string
  msg?: string
}

/** HighLevel API error body. */
export interface GhlErrorBody {
  statusCode?: number
  message?: string | string[]
  error?: string
}
