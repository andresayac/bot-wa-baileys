/**
 * @bot-wa/gupshup — configuration and Gupshup WhatsApp API wire shapes
 * (subset used). Inbound callbacks are the Gupshup **v2** format.
 */

import type { ProviderHttpOptions } from './http.js'
import type { LoggerLike } from '@bot-wa/core'

export interface GupshupProviderConfig {
  /** Account API key (`apikey` header). */
  apiKey: string
  /** Gupshup app name (`src.name`). */
  appName: string
  /** The app's WhatsApp business number, digits with country code (e.g. `'917834811114'`). */
  source: string
  /** API base. Default `'https://api.gupshup.io'`. */
  baseUrl?: string
  /**
   * Shared secret that authenticates callbacks. Gupshup does not sign its
   * callbacks, so put the secret in the callback URL you register
   * (`https://bot.example.com/gupshup?token=<secret>`) and use
   * `ingestRequest({ url, body, headers })`, or forward it as a header.
   * Compared in constant time. Required unless `allowUnsignedWebhooks`.
   */
  webhookToken?: string
  /** Header carrying the token for `ingest()`. Default `'x-webhook-token'`. */
  webhookTokenHeader?: string
  /** Query parameter carrying the token for `ingestRequest()`. Default `'token'`. */
  webhookTokenParam?: string
  /** Explicit local-development escape hatch: accept callbacks without the token. */
  allowUnsignedWebhooks?: boolean
  /** `secureFetch` options for every outbound request (REST + media). `fetch`/`resolver` are test seams. */
  http?: ProviderHttpOptions
  /** The bot's own id (defaults to `source`). */
  selfId?: string
  debug?: boolean
  logger?: LoggerLike
}

export interface GupshupSender {
  phone?: string
  name?: string
  country_code?: string
  dial_code?: string
}

/** Inner message object of a `type: 'message'` callback. */
export interface GupshupMessagePayload {
  id?: string
  source?: string
  type?: string
  payload?: Record<string, unknown>
  sender?: GupshupSender
  context?: { id?: string; gsId?: string }
  [key: string]: unknown
}

/** Inner object of a `type: 'message-event'` callback. */
export interface GupshupEventPayload {
  id?: string
  gsId?: string
  type?: string
  destination?: string
  payload?: { code?: number; reason?: string; ts?: number; [key: string]: unknown }
  [key: string]: unknown
}

/** A v2 callback envelope. */
export interface GupshupCallback {
  app?: string
  timestamp?: number
  version?: number
  type?: 'message' | 'message-event' | 'user-event' | 'billing-event' | (string & {})
  payload?: GupshupMessagePayload | GupshupEventPayload
  [key: string]: unknown
}

/** Response of `POST /wa/api/v1/msg` and `/wa/api/v1/template/msg`. */
export interface GupshupSendResponse {
  status?: string
  messageId?: string
  message?: string
}
