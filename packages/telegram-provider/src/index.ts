/**
 * @bot-wa/telegram — Telegram Bot API transport for @bot-wa/core.
 * Long-poll or webhook ingress, inline keyboards, native polls/reactions/edit.
 */

export { TelegramProvider, toProviderError } from './TelegramProvider.js'
export { parseUpdate, isEditedMessage } from './parseInbound.js'
export { toOutbound, MEDIA_UPLOAD } from './toOutbound.js'
export type { ResolvedTelegramMedia, TelegramOutbound } from './toOutbound.js'
export type {
  TelegramProviderConfig,
  TelegramResponse,
  TelegramUpdate,
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramChat,
  TelegramUser,
  TelegramFile,
  TelegramMessageEntity,
  TelegramPhotoSize,
  TelegramLocation,
  TelegramVenue,
  TelegramContact,
  TelegramPoll,
} from './types.js'
