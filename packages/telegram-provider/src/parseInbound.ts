/**
 * parseInbound — turn a Telegram Bot API {@link TelegramUpdate} into a
 * normalized {@link InboundEvent}.
 *
 * Identity resolution (done HERE so the core never re-derives it):
 *  - chatId   = String(message.chat.id)  (stable per chat, incl. negative group ids)
 *  - senderId = String(message.sender_chat.id) when the message was sent on
 *    behalf of a chat (its `from` is then a shared placeholder user), else
 *    String(message.from.id), else chat.id. All aliasing is collapsed before
 *    emission.
 *  - ref.id   = String(message_id); `eph:<id>` for ephemeral messages;
 *    inline_message_id for inline-mode callbacks; `upd:<update_id>` when the
 *    payload has no addressable message. Never ''. See refs.ts.
 *
 * Timestamps are emitted as epoch MILLISECONDS (Telegram sends seconds).
 */

import type {
  ChatInfo,
  InboundEvent,
  InboundLocation,
  InboundMessage,
  InboundInteraction,
  MediaRef,
  MessageRef,
  MessageType,
  SenderInfo,
} from '@botmesh/core'
import { toInboundLocation } from '@botmesh/core'
import type {
  TelegramCallbackQuery,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './types.js'

type TelegramId = number | string

/** A usable Bot API id: a finite number or a non-empty string. */
function isId(v: unknown): v is TelegramId {
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== '')
}

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

/** The private chat between the bot and `user` (inline-mode callbacks carry no chat). */
function userChatInfo(user: TelegramUser): ChatInfo {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username
  return {
    id: String(user.id),
    kind: 'dm',
    name: name || undefined,
    isGroup: false,
    isBroadcast: false,
    platformData: { chatType: 'private', username: user.username },
  }
}

function senderInfo(user: TelegramUser | undefined, fallbackId: string): SenderInfo {
  if (!user || !isId(user.id)) return { id: fallbackId }
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

/**
 * Who sent `msg`. A message sent on behalf of a chat (anonymous group admin,
 * linked-channel auto-forward, channel post) carries `sender_chat`; its `from`
 * is then a shared placeholder user (e.g. GroupAnonymousBot / 777000), so the
 * chat is the stable identity. Otherwise `from`, else the chat itself.
 */
function senderOf(msg: TelegramMessage, chatId: string): SenderInfo {
  const sc = msg.sender_chat
  if (sc && isId(sc.id)) {
    const info = chatInfo(sc)
    return {
      id: info.id,
      displayName: info.name,
      username: sc.username,
      isBot: false,
      platformData: { senderChat: true, chatType: sc.type },
    }
  }
  return senderInfo(msg.from, chatId)
}

/**
 * The opaque ref of `msg` (encoding documented in refs.ts), or undefined when
 * the message carries no addressable id and no `updateId` fallback was given.
 */
function messageRef(msg: TelegramMessage, chatId: string, updateId?: number): MessageRef | undefined {
  const nativeChat = isId(msg.chat?.id) ? msg.chat.id : chatId
  if (typeof msg.ephemeral_message_id === 'number') {
    return { id: `eph:${msg.ephemeral_message_id}`, chatId, native: { chat_id: nativeChat, ephemeral_message_id: msg.ephemeral_message_id } }
  }
  if (typeof msg.message_id === 'number' && msg.message_id > 0) {
    return { id: String(msg.message_id), chatId, native: { chat_id: nativeChat, message_id: msg.message_id } }
  }
  // No usable id: update_id is unique per Update and repeated on webhook retries.
  if (updateId != null) return { id: `upd:${updateId}`, chatId, native: { chat_id: nativeChat } }
  return undefined
}

function mediaOf(msg: TelegramMessage): { type: MessageType; body: string; media?: MediaRef; location?: InboundLocation } {
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
  if (msg.venue || msg.location) {
    // A venue (named place) also carries `location`; prefer the venue's own fields.
    const v = msg.venue
    const l = v?.location ?? msg.location
    const location = toInboundLocation({
      latitude: l?.latitude,
      longitude: l?.longitude,
      name: v?.title,
      address: v?.address,
      live: !v && typeof l?.live_period === 'number' && l.live_period > 0,
    })
    return { type: 'location', body: v?.title ?? v?.address ?? '', ...(location ? { location } : {}) }
  }
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

function toMessage(msg: TelegramMessage, updateId: number, selfId?: string): InboundMessage<TelegramMessage> {
  const chat = chatInfo(msg.chat)
  const chatId = chat.id
  const sender = senderOf(msg, chatId)
  const senderId = sender.id

  let type: MessageType
  let body: string
  let media: MediaRef | undefined
  let location: InboundLocation | undefined
  if (msg.text != null) {
    type = 'text'
    body = msg.text
  } else {
    const parsed = mediaOf(msg)
    type = parsed.type
    body = parsed.body
    media = parsed.media
    location = parsed.location
  }

  const replied = msg.reply_to?.message ?? msg.reply_to_message
  const quoted = replied
    ? {
        ref: messageRef(replied, chatId),
        body: replied.text ?? replied.caption,
        senderId: replied.sender_chat && isId(replied.sender_chat.id)
          ? String(replied.sender_chat.id)
          : replied.from && isId(replied.from.id) ? String(replied.from.id) : undefined,
      }
    : undefined

  // updateId is passed, so messageRef always returns a ref here.
  const ref = messageRef(msg, chatId, updateId) as MessageRef
  // An edit keeps the original id (so reply/react/edit still target the message;
  // the core deduper tells the edit apart by its content) and carries edit_date.
  if (typeof msg.edit_date === 'number' && ref.native && typeof ref.native === 'object') {
    ref.native = { ...(ref.native as Record<string, unknown>), edit_date: msg.edit_date }
  }

  return {
    ref,
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
    timestamp: msg.date ? msg.date * 1000 : Date.now(),
    mentions: mentionsOf(msg),
    quoted,
    media,
    ...(location ? { location } : {}),
    raw: msg,
  }
}

/**
 * callback_query -> interaction. Three shapes per the Bot API:
 *  - `message` (possibly an InaccessibleMessage: chat + message_id, date 0):
 *    the button's own chat/message;
 *  - `inline_message_id` (button on a message sent via the bot in inline
 *    mode): no chat is known, so the presser's private chat with the bot
 *    (`from.id`) is used and the ref carries `native.inline_message_id`, which
 *    editMessage turns into editMessageText({ inline_message_id }). Sending to
 *    that chat fails (RecipientUnreachableError) if the user never started the
 *    bot; acknowledgeInteraction (answerCallbackQuery) always works;
 *  - neither (not expected; defensive): user chat + `upd:<update_id>` ref.
 * The Bot API sends no press time: the original message date is used when
 * known and non-zero, otherwise the receive time.
 */
function toInteraction(cb: TelegramCallbackQuery, updateId: number): InboundInteraction<TelegramCallbackQuery> | undefined {
  if (typeof cb.id !== 'string' || cb.id === '' || !cb.from || !isId(cb.from.id)) return undefined
  const msg = cb.message && cb.message.chat && isId(cb.message.chat.id) ? cb.message : undefined
  const chat = msg ? chatInfo(msg.chat) : userChatInfo(cb.from)
  let ref: MessageRef
  if (msg) {
    ref = messageRef(msg, chat.id, updateId) as MessageRef
  } else if (typeof cb.inline_message_id === 'string' && cb.inline_message_id !== '') {
    ref = { id: cb.inline_message_id, chatId: chat.id, native: { inline_message_id: cb.inline_message_id } }
  } else {
    ref = { id: `upd:${updateId}`, chatId: chat.id }
  }
  const sender = senderInfo(cb.from, chat.id)
  return {
    interactionId: cb.id,
    ref,
    chat,
    senderInfo: sender,
    from: chat.id,
    sender: sender.id,
    chatId: chat.id,
    senderId: sender.id,
    isGroup: chat.isGroup,
    kind: 'button',
    data: cb.data ?? '',
    timestamp: msg?.date ? msg.date * 1000 : Date.now(),
    raw: cb,
  }
}

/**
 * Whether `message` (emitted by this provider) is an edit of an earlier message
 * (an `edited_message` update). An edit keeps the original `ref.id`, so
 * `ctx.reply`/`ctx.react`/`ctx.edit` target the edited message; its `body` is
 * the new text and `raw.edit_date` (seconds) is when it was edited.
 *
 * @example
 * ```ts
 * bot.on('message', (m) => { if (isEditedMessage(m)) audit.log('edited', m.ref.id) })
 * ```
 */
export function isEditedMessage(message: { raw?: unknown }): boolean {
  const raw = message.raw
  return typeof raw === 'object' && raw !== null && typeof (raw as { edit_date?: unknown }).edit_date === 'number'
}

/**
 * Normalize one Update. Returns undefined for update kinds this provider does
 * not surface (channel_post / edited_channel_post, business_message /
 * edited_business_message (replying needs business_connection_id),
 * guest_message (answered via answerGuestQuery), my_chat_member,
 * pre_checkout, poll updates...) and for malformed payloads that lack the ids
 * needed to route them (no chat id; no callback id or sender). Never emits an
 * event with an empty chatId, senderId or ref.id.
 */
export function parseUpdate(update: TelegramUpdate, selfId?: string): InboundEvent | undefined {
  const msg = update.message ?? update.edited_message
  if (msg) {
    if (!msg.chat || !isId(msg.chat.id)) return undefined
    return { kind: 'message', message: toMessage(msg, update.update_id, selfId) }
  }
  if (update.callback_query) {
    const interaction = toInteraction(update.callback_query, update.update_id)
    return interaction ? { kind: 'interaction', interaction } : undefined
  }
  return undefined
}
