/**
 * @bot-wa/twilio — configuration and Twilio REST wire shapes (subset used).
 */

import type { Logger } from 'pino'
import type { ProviderHttpOptions } from './http.js'

export interface TwilioProviderConfig {
  /** Account SID (`AC…`). Used in the REST path and, with `authToken`, as Basic auth. */
  accountSid: string
  /**
   * Account auth token. Signs every webhook (`X-Twilio-Signature`) and, unless
   * an API key is configured, authenticates REST calls.
   */
  authToken: string
  /** Optional API key (`SK…`) + secret for REST calls; webhooks still verify with `authToken`. */
  apiKeySid?: string
  apiKeySecret?: string
  /** Default WhatsApp sender, e.g. `'whatsapp:+14155238886'`. */
  whatsappFrom?: string
  /** Default SMS/MMS sender (E.164 number or alphanumeric sender id). */
  smsFrom?: string
  /** Messaging Service SID (`MG…`). Used as sender when no number fits the chat. */
  messagingServiceSid?: string
  /**
   * The EXACT public URL configured in Twilio for incoming messages (and
   * status callbacks), query string included. The signature covers it byte
   * for byte, so it must match what Twilio called.
   */
  webhookUrl?: string
  /**
   * Alternative to `webhookUrl`: the path of the webhook; the URL is rebuilt
   * from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`. Only use it behind a
   * proxy you control. Ignored when `webhookUrl` is set.
   */
  webhookPath?: string
  /** Status callback URL sent with every message (delivery receipts). */
  statusCallback?: string
  /** Explicit local-development escape hatch: accept webhooks without verifying the signature. */
  allowUnsignedWebhooks?: boolean
  /** REST base. Default `'https://api.twilio.com'`. */
  apiBaseUrl?: string
  /** Messaging v3 base (typing indicators). Default `'https://messaging.twilio.com'`. */
  messagingBaseUrl?: string
  /** `secureFetch` options for every outbound request (REST + media). `fetch`/`resolver` are test seams. */
  http?: ProviderHttpOptions
  /** The bot's own id (a sender number). Optional. */
  selfId?: string
  debug?: boolean
  logger?: Logger
}

/** Twilio REST error body. */
export interface TwilioErrorBody {
  code?: number
  message?: string
  more_info?: string
  status?: number
}

/** Success shape of `POST /2010-04-01/Accounts/{sid}/Messages.json` (subset). */
export interface TwilioMessageResource {
  sid?: string
  status?: string
  to?: string
  from?: string
  error_code?: number | null
  error_message?: string | null
}

/** Raw inbound payload as handed to `onEvent` listeners (`InboundMessage.raw`). */
export type TwilioWebhookParams = Record<string, string | string[]>
