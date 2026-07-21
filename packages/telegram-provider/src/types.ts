/**
 * @bot-wa/telegram — config + Telegram Bot API wire types (subset used).
 *
 * Shapes are deliberately loose (optional fields everywhere): the Bot API is
 * additive and we only read what the normalizer needs.
 */

import type { Logger } from 'pino'

export interface TelegramProviderConfig {
  /** Bot token from @BotFather. */
  token: string
  /** Bot API base URL. Default 'https://api.telegram.org'. */
  baseUrl?: string
  /**
   * true (default): start() runs a getUpdates long-poll loop.
   * false: webhook mode — the host POSTs Updates to `ingest()`.
   */
  polling?: boolean
  /** The bot's own user id (numeric, as string). If omitted, resolved via getMe. */
  selfId?: string
  /** Long-poll server timeout in seconds (getUpdates `timeout`). Default 30. */
  pollTimeout?: number
  /** Backoff (ms) after a failed getUpdates round, to avoid tight error loops. Default 1000. */
  errorBackoffMs?: number
  /** Pause (ms) after an empty getUpdates batch. Default 250 (server long-poll already waited). */
  pollIdleMs?: number
  debug?: boolean
  logger?: Logger
}

/* --- Bot API envelopes ---------------------------------------------------- */

export interface TelegramResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

/* --- Bot API domain objects (subset) -------------------------------------- */

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel' | string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
}

export interface TelegramFile {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
  mime_type?: string
  file_name?: string
  /** Sticker-only extra, surfaced on platformData. */
  emoji?: string
}

export interface TelegramLocation {
  latitude: number
  longitude: number
}

export interface TelegramContact {
  phone_number: string
  first_name?: string
  last_name?: string
  user_id?: number
}

export interface TelegramPoll {
  id: string
  question: string
  options: Array<{ text: string; voter_count?: number }>
  allows_multiple_answers?: boolean
  type?: 'regular' | 'quiz'
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
  user?: TelegramUser
}

export interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  from?: TelegramUser
  sender_chat?: TelegramChat
  date?: number
  chat: TelegramChat
  text?: string
  caption?: string
  entities?: TelegramMessageEntity[]
  caption_entities?: TelegramMessageEntity[]
  photo?: TelegramPhotoSize[]
  document?: TelegramFile
  audio?: TelegramFile
  voice?: TelegramFile
  video?: TelegramFile
  sticker?: TelegramFile
  location?: TelegramLocation
  contact?: TelegramContact
  poll?: TelegramPoll
  /** Legacy (Bot API < 7.0) reply reference. */
  reply_to_message?: TelegramMessage
  /** Bot API 7+: `reply_to.message` carries the quoted message. */
  reply_to?: { message?: TelegramMessage }
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  chat_instance?: string
  data?: string
  game_short_name?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  callback_query?: TelegramCallbackQuery
  [key: string]: unknown
}
