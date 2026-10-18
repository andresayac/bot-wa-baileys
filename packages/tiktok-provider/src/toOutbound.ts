/**
 * Map core `OutboundContent` to TikTok API request bodies.
 *
 *  - DMs → `POST /business/message/send/` (TEXT, IMAGE by `media_id`,
 *    TEMPLATE Q&A cards for buttons/lists, native passthrough).
 *  - Comment threads → `POST /business/comment/reply/create/` (text ≤ 150).
 *  - High-intent comments → `/business/message/send/` with `direct_reply`.
 *
 * Anything TikTok cannot carry rejects with `UnsupportedContentError`; limits
 * documented by TikTok reject with `PayloadTooLargeError` before any request.
 */

import { PayloadTooLargeError, UnsupportedContentError, type Button, type OutboundContent } from '@bot-wa/core'

/** DM text limit ("6,000 characters, including spaces and emojis"). */
export const DM_TEXT_LIMIT = 6000
/** Comment reply text limit (150 characters). */
export const COMMENT_TEXT_LIMIT = 150
/** Q&A card: question ≤ 40 chars, 1–3 buttons, button title ≤ 20 (button card) / ≤ 40 (link card). */
export const CARD_TITLE_LIMIT = 40
export const CARD_MAX_BUTTONS = 3
export const BUTTON_CARD_TITLE_LIMIT = 20
export const LINK_CARD_TITLE_LIMIT = 40

const charLength = (s: string): number => [...s].length

export type TikTokRequestBody = Record<string, unknown>

function nativePayload(content: OutboundContent): Record<string, unknown> | undefined {
  if (content.kind !== 'native') return undefined
  if (content.provider !== 'tiktok') throw new UnsupportedContentError('native', `native content for '${content.provider}' cannot be sent through TikTok`)
  if (typeof content.payload !== 'object' || content.payload === null || Array.isArray(content.payload)) {
    throw new UnsupportedContentError('native', 'TikTok native payload must be an object of request fields')
  }
  return content.payload as Record<string, unknown>
}

function assertText(text: string, limit: number, what: string): void {
  if (charLength(text) > limit) throw new PayloadTooLargeError(`TikTok ${what} is limited to ${limit} characters (got ${charLength(text)})`)
}

function card(kind: 'buttons' | 'list', title: string, options: Array<Pick<Button, 'id' | 'title' | 'url'>>): TikTokRequestBody {
  if (options.length === 0 || options.length > CARD_MAX_BUTTONS) {
    throw new UnsupportedContentError(kind, `TikTok Q&A cards hold 1–${CARD_MAX_BUTTONS} options (got ${options.length}); use a numbered choose() menu instead`)
  }
  if (options.some((o) => o.url)) throw new UnsupportedContentError(kind, 'TikTok Q&A cards only support reply buttons (no URL buttons)')
  assertText(title, CARD_TITLE_LIMIT, 'Q&A card question')
  const longest = Math.max(...options.map((o) => charLength(o.title)))
  if (longest > LINK_CARD_TITLE_LIMIT) throw new PayloadTooLargeError(`TikTok Q&A option titles are limited to ${LINK_CARD_TITLE_LIMIT} characters`)
  const type = kind === 'buttons' && longest <= BUTTON_CARD_TITLE_LIMIT ? 'QA_BUTTON_CARD' : 'QA_LINK_CARD'
  return {
    message_type: 'TEMPLATE',
    template: { type, title, buttons: options.map((o) => ({ type: 'REPLY', title: o.title, id: o.id })) },
  }
}

export interface DmTarget {
  businessId: string
  conversationId: string
  /** Message id to quote (text replies only). */
  quotedId?: string
  /** Already-uploaded `media_id` for an image. */
  mediaId?: string
}

/** Build a `/business/message/send/` body for a DM conversation. */
export function toDmMessage(content: OutboundContent, target: DmTarget): TikTokRequestBody {
  const base = { business_id: target.businessId, recipient_type: 'CONVERSATION', recipient: target.conversationId }
  switch (content.kind) {
    case 'text': {
      assertText(content.text, DM_TEXT_LIMIT, 'DM text')
      return {
        ...base,
        message_type: 'TEXT',
        text: { body: content.text },
        ...(target.quotedId ? { referenced_message_info: { referenced_message_id: target.quotedId } } : {}),
      }
    }
    case 'image': {
      if (!target.mediaId) throw new UnsupportedContentError('image', 'TikTok images must be uploaded first (media_id missing)')
      return { ...base, message_type: 'IMAGE', image: { media_id: target.mediaId } }
    }
    case 'buttons':
      return { ...base, ...card('buttons', content.text, content.buttons) }
    case 'list':
      return { ...base, ...card('list', content.text, content.sections.flatMap((s) => s.rows)) }
    case 'native':
      return { ...base, ...nativePayload(content) }
    default:
      throw new UnsupportedContentError(content.kind, `TikTok DMs cannot send '${content.kind}' (supported: text, image, buttons, list, native)`)
  }
}

export interface CommentTarget {
  businessId: string
  videoId: string
  commentId: string
}

/** Build a `/business/comment/reply/create/` body. Text only (or a native image reply). */
export function toCommentReply(content: OutboundContent, target: CommentTarget): TikTokRequestBody {
  const base = { business_id: target.businessId, video_id: target.videoId, comment_id: target.commentId }
  if (content.kind === 'text') {
    assertText(content.text, COMMENT_TEXT_LIMIT, 'comment reply')
    return { ...base, text: content.text }
  }
  if (content.kind === 'native') return { ...base, ...nativePayload(content) }
  throw new UnsupportedContentError(content.kind, `TikTok comment replies only support text (got '${content.kind}')`)
}

export interface DirectReplyTarget {
  businessId: string
  commentId: string
}

/** Build a Comment-to-Message direct reply (`direct_reply.reply_type = COMMENT_REPLY`). Text only. */
export function toDirectReply(content: OutboundContent, target: DirectReplyTarget): TikTokRequestBody {
  if (content.kind !== 'text') {
    throw new UnsupportedContentError(content.kind, `TikTok direct replies to comments only support text (got '${content.kind}')`)
  }
  assertText(content.text, DM_TEXT_LIMIT, 'DM text')
  return {
    business_id: target.businessId,
    direct_reply: { reply_type: 'COMMENT_REPLY', comment_reply: { comment_id: target.commentId } },
    message_type: 'TEXT',
    text: { body: content.text },
  }
}
