/**
 * @bot-wa/messenger — types for the Facebook Messenger (Meta Graph Send API)
 * transport.
 */

import type { SecureFetchOptions } from '@bot-wa/http'
import type { LoggerLike } from '@bot-wa/core'

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
  /** Explicit local-development escape hatch for unsigned webhook POSTs. */
  allowUnsignedWebhooks?: boolean
  /** Graph API version. Default 'v21.0'. */
  apiVersion?: string
  /** Graph base URL. Default 'https://graph.facebook.com'. */
  graphUrl?: string
  /** Safe-download policy for inbound media. HTTPS/public hosts are enforced by default. */
  mediaDownload?: Omit<SecureFetchOptions, 'fetch'>
  /**
   * Durable inbox (`BotConfig.durability`): hosts whose attachment URLs are journaled so a
   * replayed message can download its media again. A name also allows its subdomains.
   * Default: the Meta attachment CDNs (`META_MEDIA_HOSTS` of `@bot-wa/graph-core`). Plain
   * `http:` URLs are only accepted with `mediaDownload.allowHttp`.
   */
  mediaRefHosts?: string[]
  /** The bot's own Page-Scoped User id (for fromMe/mention logic). Optional. */
  selfId?: string
  /** Page id (or 'me') that owns the Send API endpoint. Default 'me'. */
  pageId?: string
  debug?: boolean
  logger?: LoggerLike
}

/* --- Graph API request/response shapes (subset used) --------------------- */

/** Success shape of POST /{page-id}/messages. */
export interface MessengerSendResponse {
  recipient_id?: string
  message_id?: string
  error?: {
    type?: string
    code?: number
    message?: string
    error_subcode?: number
    fbtrace_id?: string
  }
}
