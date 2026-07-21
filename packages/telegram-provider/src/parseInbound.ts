/**
 * parseInbound — turn a Telegram Bot API {@link TelegramUpdate} into a
 * normalized {@link InboundEvent}.
 *
 * Identity resolution (done HERE so the core never re-derives it):
 *  - chatId   = String(message.chat.id)  (stable per chat, incl. negative group ids)
 *  - senderId = String(message.from.id), falling back to sender_chat.id
 *    (channel posts acting as sender), then chat.id. All aliasing is collapsed
 *    before emission.
 *
 * Timestamps are emitted as epoch MILLISECONDS (Telegram sends seconds).
 */

import type {
  ChatInfo,
  InboundEvent,
  InboundMessage,
  InboundInteraction,
  MediaRef,
  MessageType,
  SenderInfo,
} from '@bot-wa/core'
import type {
  TelegramCallbackQuery,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './types.js'

function chatInfo(chat: TelegramChat): ChatInfo {
  const kind =
    chat.type === 'private' ? 'dm'
    : chat.type === 'group' || chat.type === 'supergroup' ? 'group'
    : chat.type === 'channel' ? 'channel'
    : 'dm'
  const name =
    chat.title ??
    ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username)
  return {
    id: String(chat.id),
    kind,
    name: name || undefined,
    isGroup: kind === 'group',
    isBroadcast: kind === 'channel',
    platformData: { chatType: chat.type, username: chat.username },
  }
}

function senderInfo(user: TelegramUser | undefined, fallbackId: string): SenderInfo {
  if (!user) return { id: fallbackId }
  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username
  return {
    id: String(user.id),
    displayName: displayName || undefined,
    username: user.username,
    isBot: user.is_bot,
    platformData: { languageCode: user.language_code },
  }
}

function mediaOf(msg: TelegramMessage): { type: MessageType; body: string; media?: MediaRef } {
  const caption = msg.caption ?? ''
  if (msg.photo?.length) {
    const last = msg.photo[msg.photo.length - 1]
    return {
      type: 'image',
      body: caption,
      media: { kind: 'image', filename: undefined, size: last.file_size, token: last.file_id },
    }
  }
  const single: Array<[keyof Pick<TelegramMessage, 'document' | 'audio' | 'voice' | 'video' | 'sticker'>, MediaRef['kind']]> = [
    ['document', 'document'],
    ['audio', 'audio'],
    ['voice', 'voice'],
    ['video', 'video'],
    ['sticker', 'sticker'],
  ]
  for (const [field, kind] of single) {
    const f = msg[field]
    if (f) {
      return {
        type: kind,
        body: field === 'sticker' ? (f.emoji ?? caption) : caption,
        media: { kind, mimetype: f.mime_type, filename: f.file_name, size: f.file_size, token: f.file_id },
      }
    }
  }
  if (msg.location) return { type: 'location', body: '' }
  if (msg.contact) {
    const c = msg.contact
    return { type: 'contact', body: [c.first_name, c.last_name, c.phone_number].filter(Boolean).join(' ') }
  }
  if (msg.poll) return { type: 'poll', body: msg.poll.question }
  return { type: 'unknown', body: '' }
}

function mentionsOf(msg: TelegramMessage): string[] {
  const ids = new Set<string>()
  for (const list of [msg.entities ?? [], msg.caption_entities ?? []]) {
    for (const e of list) {
      if (e.type === 'text_mention' && e.user?.id != null) ids.add(String(e.user.id))
    }
  }
  return [...ids]
}

function toMessage(msg: TelegramMessage, selfId?: string): InboundMessage<TelegramMessage> {
  const chat = chatInfo(msg.chat)
  const sender = senderInfo(msg.from, msg.sender_chat ? String(msg.sender_chat.id) : chat.id)
  const chatId = chat.id
  const senderId = sender.id

  let type: MessageType
  let body: string
  let media: MediaRef | undefined
  if (msg.text != null) {
    type = 'text'
    body = msg.text
  } else {
    const parsed = mediaOf(msg)
    type = parsed.type
    body = parsed.body
    media = parsed.media
  }

  const replied = msg.reply_to?.message ?? msg.reply_to_message
  const quoted = replied
    ? {
        ref: { id: String(replied.message_id), chatId, native: { chat_id: replied.chat.id, message_id: replied.message_id } },
        body: replied.text ?? replied.caption,
        senderId: replied.from ? String(replied.from.id) : undefined,
      }
    : undefined

  return {
    ref: { id: String(msg.message_id), chatId, native: { chat_id: msg.chat.id, message_id: msg.message_id } },
    chat,
    senderInfo: sender,
    from: chatId,
    sender: senderId,
    chatId,
    senderId,
    isGroup: chat.isGroup,
    isBroadcast: chat.isBroadcast,
    fromMe: selfId != null && senderId === selfId,
    type,
    body,
    timestamp: msg.date ? msg.date * 1000 : 0,
    mentions: mentionsOf(msg),
    quoted,
    media,
    raw: msg,
  }
}

function toInteraction(cb: TelegramCallbackQuery): InboundInteraction<TelegramCallbackQuery> {
  const msg = cb.message
  const chat = msg
    ? chatInfo(msg.chat)
    : { id: '', kind: 'dm' as const, isGroup: false, isBroadcast: false }
  const sender = senderInfo(cb.from, chat.id)
  return {
    interactionId: cb.id,
    ref: {
      id: msg ? String(msg.message_id) : '',
      chatId: chat.id,
      native: msg ? { chat_id: msg.chat.id, message_id: msg.message_id } : undefined,
    },
    chat,
    senderInfo: sender,
    from: chat.id,
    sender: sender.id,
    chatId: chat.id,
    senderId: sender.id,
    isGroup: chat.isGroup,
    kind: 'button',
    data: cb.data ?? '',
    timestamp: msg?.date ? msg.date * 1000 : 0,
    raw: cb,
  }
}

/**
 * Normalize one Update. Returns undefined for update kinds this provider does
 * not surface (channel_post, edited channel posts, pre_checkout, poll updates…).
 */
export function parseUpdate(update: TelegramUpdate, selfId?: string): InboundEvent | undefined {
  const msg = update.message ?? update.edited_message
  if (msg) return { kind: 'message', message: toMessage(msg, selfId) }
  if (update.callback_query) return { kind: 'interaction', interaction: toInteraction(update.callback_query) }
  return undefined
}
