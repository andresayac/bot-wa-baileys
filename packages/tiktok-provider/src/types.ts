/**
 * @bot-wa/tiktok — configuration and TikTok API for Business payload shapes
 * (subset used). Field names follow the official v1.3 docs.
 */

import type { Logger } from 'pino'
import type { SecureFetchOptions } from '@bot-wa/http'

/** Access token, or a function returning the current one (TikTok account tokens expire after 24 h). */
export type TikTokAccessToken = string | (() => string | Promise<string>)

export interface TikTokProviderConfig {
  /**
   * TikTok account access token (sent as the `Access-Token` header). Pass a
   * function to plug in your own refresh logic (`/tt_user/oauth2/refresh_token/`).
   */
  accessToken: TikTokAccessToken
  /**
   * Application-specific id of the TikTok account (`open_id` from
   * `/tt_user/oauth2/token/`). Sent as `business_id`; webhooks whose
   * `user_openid` differs (another account on the same app) are ignored.
   */
  businessId: string
  /**
   * Developer app secret: verifies the `TikTok-Signature` header of every
   * webhook (HMAC-SHA256 over `${t}.${rawBody}`). Required in production.
   */
  appSecret?: string
  /** Explicit local-development escape hatch for unsigned webhook POSTs. */
  allowUnsignedWebhooks?: boolean
  /** Accepted |now - t| for webhook timestamps, in seconds (replay window). Default 300. */
  signatureToleranceSec?: number
  /** API base URL. Default `https://business-api.tiktok.com/open_api`. */
  apiBaseUrl?: string
  /** API version path segment. Default `v1.3`. */
  apiVersion?: string
  /**
   * `unique_identifier` of the business's own TikTok account (the value TikTok
   * puts in `comment.update` for comments the account posts). **Required to
   * receive comments**: it is the loop guard — the account's own comments,
   * including the bot's replies seen by another instance or after a restart,
   * arrive as `fromMe: true` and are never dispatched. Without it, comment
   * webhooks are ignored; DMs work either way.
   */
  selfUniqueIdentifier?: string
  /**
   * Options for every outbound request (API calls and media downloads), which
   * all go through `secureFetch` (HTTPS only, public hosts, timeouts, size
   * caps). `fetch` / `resolver` are injection points for tests.
   */
  http?: Omit<SecureFetchOptions, 'method' | 'body' | 'headers' | 'signal'>
  debug?: boolean
  logger?: Logger
}

/* --- Webhooks ------------------------------------------------------------ */

/** Common webhook envelope (`webhook-schema-version: 1.0`). `content` is a serialized JSON string. */
export interface TikTokWebhookBody {
  client_key?: string
  event?: string
  create_time?: number
  user_openid?: string
  content?: string
}

/** `content` of `comment.update`. Ids arrive as JSON numbers; normalized to strings. */
export interface TikTokCommentUpdate {
  comment_id?: string | number
  video_id?: string | number
  parent_comment_id?: string | number
  comment_type?: 'comment' | 'reply'
  comment_action?: 'insert' | 'delete' | 'set_to_hidden' | 'set_to_friends_only' | 'set_to_public'
  timestamp?: number
  unique_identifier?: string
  text?: string
}

export interface TikTokParticipant {
  id?: string
  role?: 'business_account' | 'personal_account'
}

export interface TikTokReaction {
  operation?: 'ADD' | 'REMOVE'
  type?: 'EMOJI' | 'AI_EMOJI'
  emoji?: string
  ai_emoji_url?: string
  unique_identifier?: string
  timestamp?: number
  original_msg_id?: string
}

/** `content` of `im_receive_msg` / `im_send_msg`. */
export interface TikTokDirectMessage {
  from?: string
  to?: string
  unique_identifier?: string
  from_user?: TikTokParticipant
  to_user?: TikTokParticipant
  conversation_id?: string
  message_id?: string
  timestamp?: number
  type?: string
  text?: { body?: string }
  image?: { media_id?: string }
  video?: { media_id?: string }
  sticker?: { url?: string }
  emoji?: { url?: string }
  share_post?: { video_id?: string; embed_url?: string }
  reaction?: TikTokReaction[]
  template?: unknown
  referenced_message_info?: { referenced_message_id?: string }
  reply_source_payload?: { reply_source_msg_id?: string; reply_source_unique_id?: string }
  auto_message_type?: string
  scene_type?: number
  is_follower?: boolean
  message_tag?: { source?: string }
}

/** `content` of `im_receive_high_intent_comment`. */
export interface TikTokHighIntentComment {
  from?: string
  to?: string
  unique_identifier?: string
  from_user?: TikTokParticipant
  to_user?: TikTokParticipant
  comment_id?: string | number
  comment_text?: string
  is_follower?: boolean
  timestamp?: number
}

/** Token carried by `MediaRef.token` for DM media (resolved with `/business/message/media/download/`). */
export interface TikTokMediaToken {
  mediaId: string
  messageId: string
  conversationId: string
  mediaType: 'IMAGE' | 'VIDEO'
}

/* --- API responses ------------------------------------------------------- */

/** Every TikTok API for Business response: `code` 0 = success. */
export interface TikTokApiResponse<T = unknown> {
  code?: number
  message?: string
  request_id?: string
  data?: T
}
