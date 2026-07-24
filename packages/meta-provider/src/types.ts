/**
 * @bot-wa/meta — types for the WhatsApp Cloud API (official Meta) transport.
 */

import type { Logger } from 'pino'
import type { SecureFetchOptions } from '@bot-wa/http'

export interface CloudAPIProviderConfig {
  /** Permanent (system-user) access token with whatsapp_business_messaging. */
  accessToken: string
  /** The phone-number id of the sending number (from the Meta app dashboard). */
  phoneNumberId: string
  /** Shared secret the host configured in the webhook subscription (GET verify). */
  verifyToken: string
  /**
   * App secret — when set, inbound POSTs are verified against the
   * `X-Hub-Signature-256` header (HMAC-SHA256). Strongly recommended.
  */
  appSecret?: string
  /**
   * Explicitly allow unsigned webhook POSTs. Intended only for isolated local
   * development; production deployments should always configure `appSecret`.
   */
  allowUnsignedWebhooks?: boolean
  /** Graph API version. Default 'v21.0'. */
  apiVersion?: string
  /** Graph base URL. Default 'https://graph.facebook.com'. */
  graphUrl?: string
  /** Safe-download policy for inbound media. HTTPS/public hosts are enforced by default. */
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
  /** The bot's own wa_id (for identity/mention logic). Optional. */
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

export interface GraphSendMessageResponse {
  messages?: Array<{ id: string }>
  error?: GraphErrorBody['error']
}
