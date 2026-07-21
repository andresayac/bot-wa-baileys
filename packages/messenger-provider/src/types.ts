/**
 * @bot-wa/messenger — types for the Facebook Messenger (Meta Graph Send API)
 * transport.
 */

import type { Logger } from 'pino'

export interface MessengerProviderConfig {
  /** Page access token with pages_messaging (from the Meta app dashboard). */
  accessToken: string
  /** Shared secret the host configured in the webhook subscription (GET verify). */
  verifyToken: string
  /**
   * App secret — when set, inbound POSTs are verified against the
   * `X-Hub-Signature-256` header (HMAC-SHA256). Strongly recommended.
   */
  appSecret?: string
  /** Graph API version. Default 'v21.0'. */
  apiVersion?: string
  /** Graph base URL. Default 'https://graph.facebook.com'. */
  graphUrl?: string
  /** The bot's own Page-Scoped User id (for fromMe/mention logic). Optional. */
  selfId?: string
  /** Page id (or 'me') that owns the Send API endpoint. Default 'me'. */
  pageId?: string
  debug?: boolean
  logger?: Logger
}

/* --- Graph API request/response shapes (subset used) --------------------- */

export interface GraphErrorBody {
  error?: {
    type?: string
    code?: number
    message?: string
    error_subcode?: number
    fbtrace_id?: string
  }
}

/** Success shape of POST /{page-id}/messages. */
export interface MessengerSendResponse {
  recipient_id?: string
  message_id?: string
  error?: GraphErrorBody['error']
}
