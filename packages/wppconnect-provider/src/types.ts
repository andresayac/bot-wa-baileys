/**
 * @bot-wa/wppconnect — config + wppconnect-server wire types (the subset used).
 *
 * WPPConnect relays WA-JS objects, whose ids are either serialized strings
 * (`false_573001112233@c.us_3EB0…`) or `{ _serialized, … }` objects depending
 * on the event, so every id field is typed loosely.
 */

import type { Logger } from 'pino'
import type { RestHttpOptions } from './rest.js'

export interface WPPConnectProviderConfig {
  /** wppconnect-server base URL. Default `http://localhost:21465`. */
  baseUrl?: string
  /** Session name (`/api/{session}/…`). */
  session: string
  /** Bearer token from `POST /api/{session}/{secretKey}/generate-token`. */
  token?: string
  /**
   * The server's `secretKey`: when set (and `token` is not), the provider
   * generates the session token on `start()` and regenerates it once on a 401.
   */
  secretKey?: string
  /**
   * Shared secret for webhook ingest. wppconnect-server cannot sign webhooks or
   * add headers, so put it in the webhook URL (`…/webhook?token=<secret>`) and
   * pass the request URL to `ingest(body, headers, url)`; a proxy may instead
   * send it in the {@link webhookTokenHeader} header or as `Authorization: Bearer`.
   */
  webhookToken?: string
  /** Header carrying {@link webhookToken}. Default `x-webhook-token`. */
  webhookTokenHeader?: string
  /** Query-string parameter carrying {@link webhookToken}. Default `token`. */
  webhookTokenParam?: string
  /** Explicit local-development escape hatch: accept webhooks without any check. */
  allowUnsignedWebhooks?: boolean
  /** Call `start-session` on `start()`. Default true. */
  startSession?: boolean
  /** Per-session webhook URL sent with `start-session` (must be in the server's allowed URLs). */
  webhookUrl?: string
  /**
   * Resolve unknown LIDs (`…@lid`) to phone numbers through
   * `GET /api/{session}/contact/pn-lid/{lid}` before emitting. Default true.
   */
  resolveLid?: boolean
  /** The connected number (`573…@c.us`); learned from inbound DMs when omitted. */
  selfId?: string
  /** Network policy for REST calls to wppconnect-server. */
  http?: RestHttpOptions
  /** Max aliases kept by the LID↔PN identity map. Default 10 000. */
  identityCacheSize?: number
  debug?: boolean
  logger?: Logger
}

/** A WA-JS id: serialized string or a `Wid`/`MsgKey`-like object. */
export type WppId = string | { _serialized?: string; id?: string; remote?: unknown; fromMe?: boolean; user?: string; server?: string }

export interface WppSender {
  id?: WppId
  pushname?: string
  name?: string
  shortName?: string
  formattedName?: string
  isMe?: boolean
  isBusiness?: boolean
  isMyContact?: boolean
  /** Newer WA-JS builds attach the PN twin of a LID sender. */
  phoneNumber?: WppId
  lid?: WppId
}

/** `onmessage` webhook payload (WA-JS message + `event` / `session`). */
export interface WppMessage {
  event?: string
  session?: string
  id: WppId
  body?: string
  type?: string
  t?: number
  notifyName?: string
  from?: WppId
  to?: WppId
  author?: WppId
  chatId?: WppId
  fromMe?: boolean
  isGroupMsg?: boolean
  sender?: WppSender
  caption?: string
  mimetype?: string
  filename?: string
  size?: number
  lat?: number
  lng?: number
  loc?: string
  vcardFormattedName?: string
  pollName?: string
  quotedMsg?: { type?: string; body?: string; caption?: string }
  quotedMsgId?: WppId
  quotedStanzaID?: string
  quotedParticipant?: WppId
  mentionedJidList?: WppId[]
  [key: string]: unknown
}

/** Opaque handle stored in `MediaRef.token`. */
export interface WppMediaToken {
  messageId: string
}
