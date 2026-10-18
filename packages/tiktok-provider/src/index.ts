/**
 * @bot-wa/tiktok — TikTok transport for @bot-wa/core over the official TikTok
 * API for Business: comment replies on owned videos (Accounts API) and direct
 * messages (Business Messaging API), webhook-driven with TikTok-Signature
 * verification.
 */

export { TikTokProvider } from './TikTokProvider.js'
export { TikTokApiError, toProviderError } from './errors.js'
export type { TikTokErrorInput } from './errors.js'
export { parseWebhook } from './parseInbound.js'
export type { TikTokInboundRaw, ParseWebhookOptions, ConversationChatInfo } from './parseInbound.js'
export { toDmMessage, toCommentReply, toDirectReply, DM_TEXT_LIMIT, COMMENT_TEXT_LIMIT } from './toOutbound.js'
export type { TikTokRequestBody, DmTarget, CommentTarget, DirectReplyTarget } from './toOutbound.js'
export { verifyTikTokSignature, parseSignatureHeader } from './signature.js'
export type { SignatureCheck, ParsedSignatureHeader, VerifySignatureOptions } from './signature.js'
export { parseTikTokChatId, conversationChatId, commentChatId, highIntentChatId } from './chatId.js'
export type { TikTokChatTarget } from './chatId.js'
export { parseJsonLossless } from './json.js'
export type {
  TikTokProviderConfig,
  TikTokAccessToken,
  TikTokWebhookBody,
  TikTokCommentUpdate,
  TikTokDirectMessage,
  TikTokHighIntentComment,
  TikTokParticipant,
  TikTokReaction,
  TikTokMediaToken,
  TikTokApiResponse,
} from './types.js'
