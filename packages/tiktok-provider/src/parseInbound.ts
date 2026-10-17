/**
 * Normalize TikTok webhooks into core `InboundEvent`s.
 *
 * Identity: every TikTok user is keyed by `unique_identifier` — TikTok's
 * globally unique, cross-API user id (the same value in `comment.update`, in
 * DMs as `from_user.id` of a personal account, and in the comment list API).
 * So one person keeps one `senderId` across comments and DMs; nothing to
 * reconcile downstream.
 *
 * Surfaces:
 *  - `comment.update` (Accounts API, `COMMENT` webhook) — only `insert`
 *    actions become messages. Chat = the thread of the top-level comment
 *    (`parent_comment_id` for replies), kind `group`: a public thread several
 *    people can post in, so conversations are per participant by default.
 *  - `im_receive_msg` (Business Messaging, `DIRECT_MESSAGE` webhook) — DM
 *    messages, Q&A-card clicks (button interactions) and reactions.
 *  - `im_send_msg` — our own outbound (any source) → `sent` status.
 *  - `im_receive_high_intent_comment` — Comment-to-Message (VN/ID/TH only).
 *  - `im_receive_msg_eu` carries no content (EEA/CH/UK) and is dropped, like
 *    referral / read / auto-message configuration events.
 */

import type {
  ChatInfo,
  InboundEvent,
  InboundMessage,
  MediaRef,
  MessageType,
  SenderInfo,
} from '@bot-wa/core'
import { commentChatId, conversationChatId, highIntentChatId } from './chatId.js'
import { idString, parseJsonLossless } from './json.js'
import type {
  TikTokCommentUpdate,
  TikTokDirectMessage,
  TikTokHighIntentComment,
  TikTokMediaToken,
  TikTokWebhookBody,
} from './types.js'

/** Raw payload on emitted events: the envelope with `content` already decoded. */
export interface TikTokInboundRaw {
  event: string
  userOpenId: string
  createTime?: number
  content: unknown
}

export interface ParseWebhookOptions {
  /** The business's own `unique_identifier`: its comments are flagged `fromMe`. */
  selfUniqueIdentifier?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function decodeContent(content: unknown): Record<string, unknown> | undefined {
  if (isRecord(content)) return content
  if (typeof content !== 'string') return undefined
  try {
    const parsed = parseJsonLossless(content)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function eventTime(ms: unknown, body: TikTokWebhookBody): number {
  if (typeof ms === 'number' && Number.isFinite(ms)) return ms
  return typeof body.create_time === 'number' ? body.create_time * 1000 : 0
}

/** Parse one webhook envelope into normalized events (empty when nothing applies). */
export function parseWebhook(body: TikTokWebhookBody, options: ParseWebhookOptions = {}): InboundEvent<TikTokInboundRaw>[] {
  if (typeof body !== 'object' || body === null || typeof body.event !== 'string') return []
  const content = decodeContent(body.content)
  if (!content) return []
  const raw: TikTokInboundRaw = { event: body.event, userOpenId: body.user_openid ?? '', createTime: body.create_time, content }
  switch (body.event) {
    case 'comment.update':
      return parseComment(content as TikTokCommentUpdate, body, raw, options)
    case 'im_receive_msg':
      return parseDirectMessage(content as TikTokDirectMessage, body, raw)
    case 'im_send_msg':
      return parseSentEcho(content as TikTokDirectMessage, body)
    case 'im_receive_high_intent_comment':
      return parseHighIntent(content as TikTokHighIntentComment, body, raw)
    default:
      return []
  }
}

/* --- comments ------------------------------------------------------------ */

function parseComment(c: TikTokCommentUpdate, body: TikTokWebhookBody, raw: TikTokInboundRaw, options: ParseWebhookOptions): InboundEvent<TikTokInboundRaw>[] {
  if (c.comment_action !== 'insert') return []
  const commentId = idString(c.comment_id)
  const videoId = idString(c.video_id)
  const parentId = idString(c.parent_comment_id)
  const senderId = c.unique_identifier ?? ''
  if (!commentId || !videoId || !senderId) return []
  const threadId = parentId || commentId
  const chatId = commentChatId(videoId, threadId)
  const chat: ChatInfo = {
    id: chatId,
    kind: 'group',
    isGroup: true,
    isBroadcast: false,
    platformData: {
      surface: 'comment',
      videoId,
      commentId: threadId,
      commentType: c.comment_type ?? (parentId ? 'reply' : 'comment'),
      ...(parentId ? { parentCommentId: parentId } : {}),
    },
  }
  const message: InboundMessage<TikTokInboundRaw> = {
    ref: { id: commentId, chatId, native: { videoId, commentId, parentCommentId: parentId || undefined } },
    chat,
    senderInfo: { id: senderId, platformData: { surface: 'comment' } },
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup: true,
    isBroadcast: false,
    fromMe: !!options.selfUniqueIdentifier && senderId === options.selfUniqueIdentifier,
    type: 'text',
    body: c.text ?? '',
    timestamp: eventTime(c.timestamp, body),
    mentions: [],
    raw,
  }
  return [{ kind: 'message', message }]
}

/* --- direct messages ----------------------------------------------------- */

function dmChat(chatId: string, conversationId: string, m: TikTokDirectMessage): ChatInfo {
  return {
    id: chatId,
    kind: 'dm',
    isGroup: false,
    isBroadcast: false,
    ...(m.from ? { name: m.from } : {}),
    platformData: { surface: 'dm', conversationId },
  }
}

function dmSender(m: TikTokDirectMessage, senderId: string): SenderInfo {
  return {
    id: senderId,
    ...(m.from ? { username: m.from } : {}),
    platformData: {
      surface: 'dm',
      ...(typeof m.is_follower === 'boolean' ? { isFollower: m.is_follower } : {}),
      ...(m.message_tag?.source ? { source: m.message_tag.source } : {}),
    },
  }
}

function personalSender(m: { from_user?: { id?: string; role?: string }; unique_identifier?: string }): string {
  if (m.from_user?.role === 'personal_account' && m.from_user.id) return m.from_user.id
  return m.unique_identifier ?? m.from_user?.id ?? ''
}

function mediaFor(m: TikTokDirectMessage, conversationId: string, messageId: string): { type: MessageType; media?: MediaRef; body: string } {
  switch (m.type) {
    case 'text':
      return { type: 'text', body: m.text?.body ?? '' }
    case 'image':
    case 'video': {
      const mediaId = (m.type === 'image' ? m.image : m.video)?.media_id
      if (!mediaId) return { type: 'unknown', body: '' }
      const token: TikTokMediaToken = { mediaId, messageId, conversationId, mediaType: m.type === 'image' ? 'IMAGE' : 'VIDEO' }
      return { type: m.type, body: '', media: { kind: m.type, token } }
    }
    case 'sticker':
    case 'emoji': {
      const url = (m.type === 'sticker' ? m.sticker : m.emoji)?.url
      return url ? { type: 'sticker', body: '', media: { kind: 'sticker', token: { url } } } : { type: 'unknown', body: '' }
    }
    case 'share_post':
      return { type: 'unknown', body: m.share_post?.embed_url ?? '' }
    default:
      return { type: 'unknown', body: '' }
  }
}

function parseDirectMessage(m: TikTokDirectMessage, body: TikTokWebhookBody, raw: TikTokInboundRaw): InboundEvent<TikTokInboundRaw>[] {
  const conversationId = m.conversation_id ?? ''
  const senderId = personalSender(m)
  if (!conversationId || !senderId) return []
  const chatId = conversationChatId(conversationId)
  const messageId = m.message_id ?? ''
  const timestamp = eventTime(m.timestamp, body)
  const chat = dmChat(chatId, conversationId, m)
  const senderInfo = dmSender(m, senderId)

  if (m.type === 'reaction') {
    return (m.reaction ?? [])
      .filter((r) => r.original_msg_id)
      .map((r) => ({
        kind: 'reaction' as const,
        reaction: {
          ref: { id: r.original_msg_id ?? '', chatId },
          emoji: r.emoji ?? r.ai_emoji_url ?? '',
          senderId: r.unique_identifier ?? senderId,
          ...(r.operation === 'REMOVE' ? { removed: true } : {}),
        },
      }))
  }

  const buttonId = m.reply_source_payload?.reply_source_unique_id
  if (m.type === 'text' && m.reply_source_payload) {
    return [{
      kind: 'interaction',
      interaction: {
        interactionId: messageId,
        ref: { id: messageId, chatId },
        chat,
        senderInfo,
        from: chatId, sender: senderId, chatId, senderId,
        isGroup: false,
        kind: 'button',
        data: buttonId || m.text?.body || '',
        timestamp,
        raw,
      },
    }]
  }

  const { type, media, body: text } = mediaFor(m, conversationId, messageId)
  const quotedId = m.referenced_message_info?.referenced_message_id
  const message: InboundMessage<TikTokInboundRaw> = {
    ref: { id: messageId, chatId },
    chat,
    senderInfo,
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup: false,
    isBroadcast: false,
    fromMe: false,
    type,
    body: text,
    timestamp,
    mentions: [],
    ...(quotedId ? { quoted: { ref: { id: quotedId, chatId } } } : {}),
    ...(media ? { media } : {}),
    raw,
  }
  return [{ kind: 'message', message }]
}

function parseSentEcho(m: TikTokDirectMessage, body: TikTokWebhookBody): InboundEvent<TikTokInboundRaw>[] {
  const conversationId = m.conversation_id ?? ''
  if (!conversationId || !m.message_id) return []
  const recipient = m.to_user?.role === 'personal_account' ? m.to_user.id : m.unique_identifier
  return [{
    kind: 'status',
    status: {
      ref: { id: m.message_id, chatId: conversationChatId(conversationId) },
      status: 'sent',
      ...(recipient ? { recipient } : {}),
      timestamp: eventTime(m.timestamp, body),
    },
  }]
}

function parseHighIntent(c: TikTokHighIntentComment, body: TikTokWebhookBody, raw: TikTokInboundRaw): InboundEvent<TikTokInboundRaw>[] {
  const commentId = idString(c.comment_id)
  const senderId = personalSender(c)
  if (!commentId || !senderId) return []
  const chatId = highIntentChatId(commentId)
  const message: InboundMessage<TikTokInboundRaw> = {
    ref: { id: commentId, chatId },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false, platformData: { surface: 'high-intent-comment', commentId } },
    senderInfo: {
      id: senderId,
      ...(c.from ? { username: c.from } : {}),
      platformData: { surface: 'high-intent-comment', ...(typeof c.is_follower === 'boolean' ? { isFollower: c.is_follower } : {}) },
    },
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup: false,
    isBroadcast: false,
    fromMe: false,
    type: 'text',
    body: c.comment_text ?? '',
    timestamp: eventTime(c.timestamp, body),
    mentions: [],
    raw,
  }
  return [{ kind: 'message', message }]
}
