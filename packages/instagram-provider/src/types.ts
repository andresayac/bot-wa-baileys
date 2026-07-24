/**
 * @bot-wa/instagram — types for the Instagram DM (Messenger API for Instagram,
 * Meta Graph) transport. The IG account is connected to a Facebook Page; events
 * arrive on the same 'page' webhook object and sending goes through the Send API.
 */

import type { Logger } from 'pino'
import type { SecureFetchOptions } from '@bot-wa/http'

export interface InstagramProviderConfig {
  /** Page access token of the Facebook Page the IG account is connected to. */
  accessToken: string
  /** Shared secret the host configured in the webhook subscription (GET verify). */
  verifyToken: string
  /**
   * App secret — when set, inbound POSTs are verified against the
   * `X-Hub-Signature-256` header (HMAC-SHA256). Strongly recommended.
  */
  appSecret?: string
  /** Explicit local-development escape hatch for unsigned webhook POSTs. */
  allowUnsignedWebhooks?: boolean
  /** Graph API version. Default 'v21.0'. */
  apiVersion?: string
  /** Graph base URL. Default 'https://graph.facebook.com'. */
  graphUrl?: string
  /** Safe-download policy for inbound media. HTTPS/public hosts are enforced by default. */
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
  /** The bot's own IG user id (IGSID). Optional. */
  selfId?: string
  debug?: boolean
  logger?: Logger
}

/* --- Graph API request/response shapes (subset used) --------------------- */

export interface GraphErrorBody {
  error?: {
    code?: number
    message?: string
    error_subcode?: number
    fbtrace_id?: string
  }
}

export interface GraphSendResponse {
  recipient_id?: string
  message_id?: string
  error?: GraphErrorBody['error']
}
