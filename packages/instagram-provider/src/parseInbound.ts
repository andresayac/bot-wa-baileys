/**
 * parseInbound — turn an Instagram DM webhook body (the 'page' webhook object
 * used by the Messenger API for Instagram) into normalized {@link InboundEvent}s.
 *
 * Shape: `{ object:'page', entry:[{ messaging:[...] }] }`. Each messaging event
 * carries `sender.id` / `recipient.id` / `timestamp` (epoch **ms**) and one of:
 * `message` (text, attachments, quick_reply — `is_echo` marks our own messages),
 * `reaction`, `postback` or a story mention/reply. Identity is the IG user id
 * (IGSID) of the sender — stable, opaque.
 */

import type {
  InboundEvent,
  InboundInteraction,
  InboundMessage,
  InboundReaction,
  MediaRef,
  MessageType,
} from '@bot-wa/core'

/* Loose webhook shapes (only the fields we read). */
interface IgAttachmentPayload {
  url?: string
  title?: string
  sticker_id?: string
}
interface IgAttachment {
  /** image | video | audio | file | share | fallback | story_mention | ... */
  type?: string
  title?: string
  payload?: IgAttachmentPayload
}
interface IgMessage {
  mid?: string
  text?: string
  /** True when this message was sent by the connected IG account (our own). */
  is_echo?: boolean
  attachments?: IgAttachment[]
  quick_reply?: { payload?: string }
  reply_to?: { mid?: string }
  /** Present when the user replied to one of our stories. */
  story?: { id?: string; url?: string }
}
interface IgReaction {
  /** id of the reacted-to message. */
  mid?: string
  /** 'react' | 'unreact' */
  action?: string
  /** The reaction as sent ('😀'). */
  reaction?: string
  /** The unicode emoji ('❤️'). */
  emoji?: string
}
interface IgPostback {
  payload?: string
  title?: string
  mid?: string
}
export interface IgMessagingEvent {
  sender?: { id?: string }
  recipient?: { id?: string }
  /** Epoch milliseconds. */
  timestamp?: number
  message?: IgMessage
  reaction?: IgReaction
  postback?: IgPostback
  /** Present when the user replied to a story. */
  story?: { id?: string; url?: string }
}
interface IgEntry {
  id?: string
  time?: number
  messaging?: IgMessagingEvent[]
}
export interface IgWebhookBody {
  /** 'page' for IG DMs via the Messenger API ('instagram' is also accepted). */
  object?: string
  entry?: IgEntry[]
}

/** Attachment types with a direct MediaRef mapping (token = hosted url). */
const ATTACH_MEDIA: Record<string, { type: MessageType; kind: MediaRef['kind'] }> = {
  image: { type: 'image', kind: 'image' },
  video: { type: 'video', kind: 'video' },
  audio: { type: 'audio', kind: 'audio' },
  file: { type: 'document', kind: 'document' },
  story_mention: { type: 'image', kind: 'image' },
}

/**
 * Id for a payload that arrived without a `mid`. Core dedupes inbound events by
 * `chatId` + id, so the id must be unique per logical event and stable across
 * redelivery: `ig_<timestamp>` (epoch ms, identical on a Meta retry) is both.
 * Without a timestamp there is nothing per-event to key on, so return `''`
 * (never deduplicated) instead of a shared constant like `ig_0`, which would
 * drop every later id-less event of the chat as a duplicate.
 */
function fallbackId(ev: IgMessagingEvent): string {
  return typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp) ? `ig_${ev.timestamp}` : ''
}

function toMessage(ev: IgMessagingEvent): InboundMessage<IgMessagingEvent> {
  const chatId = ev.sender?.id ?? ''
  const msg = ev.message!
  let type: MessageType = msg.text ? 'text' : 'unknown'
  let body = msg.text ?? ''
  let media: MediaRef | undefined

  const att = msg.attachments?.[0]
  if (att) {
    const url = att.payload?.url
    if (att.type === 'share') {
      // A shared IG post — no media bytes, just a link/title.
      type = 'unknown'
      body = att.payload?.url ?? att.payload?.title ?? att.title ?? ''
    } else {
      const known = ATTACH_MEDIA[att.type ?? '']
      if (known && url) {
        type = known.type
        media = { kind: known.kind, token: url }
      } else {
        type = 'unknown'
        body = att.title ?? att.payload?.title ?? ''
      }
    }
  }

  return {
    ref: { id: msg.mid ?? fallbackId(ev), chatId, native: ev },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: chatId },
    from: chatId,
    sender: chatId,
    chatId,
    senderId: chatId,
    isGroup: false,
    isBroadcast: false,
    fromMe: false,
    type,
    body,
    timestamp: ev.timestamp ?? 0,
    mentions: [],
    media,
    quoted: msg.reply_to?.mid ? { ref: { id: msg.reply_to.mid, chatId } } : undefined,
    raw: ev,
  }
}

function toInteraction(ev: IgMessagingEvent, data: string, mid?: string): InboundInteraction<IgMessagingEvent> {
  const chatId = ev.sender?.id ?? ''
  const interactionId = mid ?? fallbackId(ev)
  return {
    interactionId,
    ref: { id: interactionId, chatId, native: ev },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: chatId },
    from: chatId,
    sender: chatId,
    chatId,
    senderId: chatId,
    isGroup: false,
    kind: 'button',
    data,
    timestamp: ev.timestamp ?? 0,
    raw: ev,
  }
}

function toReaction(ev: IgMessagingEvent): InboundReaction {
  const chatId = ev.sender?.id ?? ''
  const r = ev.reaction!
  return {
    ref: { id: r.mid ?? '', chatId, native: ev },
    emoji: r.emoji ?? r.reaction ?? '',
    senderId: chatId,
    removed: r.action === 'unreact',
  }
}

/** Parse a full 'page' webhook body into a flat list of events. */
export function parseInbound(body: IgWebhookBody): InboundEvent[] {
  const events: InboundEvent[] = []
  if (body.object !== 'page' && body.object !== 'instagram') return events

  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      if (!ev.sender?.id) continue

      // Reaction → reaction event.
      if (ev.reaction) {
        events.push({ kind: 'reaction', reaction: toReaction(ev) })
        continue
      }
      // Get-started / menu postback → interaction.
      if (ev.postback) {
        events.push({ kind: 'interaction', interaction: toInteraction(ev, ev.postback.payload ?? '', ev.postback.mid) })
        continue
      }

      const msg = ev.message
      if (!msg) continue
      // is_echo = a message the connected IG account sent itself; skip it.
      if (msg.is_echo) continue
      // Quick reply tap → interaction (IG has no structured postback buttons).
      if (msg.quick_reply) {
        events.push({ kind: 'interaction', interaction: toInteraction(ev, msg.quick_reply.payload ?? '', msg.mid) })
        continue
      }
      events.push({ kind: 'message', message: toMessage(ev) })
    }
  }
  return events
}
