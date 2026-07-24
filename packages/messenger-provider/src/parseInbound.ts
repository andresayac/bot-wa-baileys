/**
 * parseInbound — turn a Facebook Messenger `page` webhook body into normalized
 * {@link InboundEvent}s. Identity is the Page-Scoped User id (`sender.id`):
 * stable per page↔user pair, no aliasing to reconcile.
 *
 * Webhook shape: `{ object:'page', entry:[{ messaging:[ {sender, recipient,
 * timestamp, message|postback|opt_in|referral} ] }] }`.
 */

import type {
  InboundEvent,
  InboundMessage,
  MediaRef,
  MessageType,
} from '@bot-wa/core'

/* Loose Messenger webhook shapes (only the fields we read). */

export interface MessengerAttachment {
  type?: string // 'image' | 'video' | 'audio' | 'file' | 'location' | 'fallback'
  payload?: { url?: string; title?: string }
}

export interface MessengerMessage {
  mid?: string
  text?: string
  attachments?: MessengerAttachment[]
  quick_reply?: { payload?: string }
  sticker_id?: number
  is_echo?: boolean
  reaction?: { reaction?: string; emoji?: string; action?: string; mid?: string }
}

export interface MessagingEvent {
  sender?: { id?: string; user_ref?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: MessengerMessage
  postback?: { mid?: string; payload?: string; title?: string }
  optin?: { ref?: string; user_ref?: string; payload?: string }
  referral?: { ref?: string; source?: string; type?: string }
}

export interface PageWebhookBody {
  object?: string
  entry?: Array<{ id?: string; time?: number; messaging?: MessagingEvent[] }>
}

const ATTACH_MIME: Record<string, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/aac',
  file: 'application/octet-stream',
}

/** Map a Messenger attachment type to a neutral MessageType (files → document). */
function attachType(type: string | undefined): MessageType {
  switch (type) {
    case 'image': return 'image'
    case 'video': return 'video'
    case 'audio': return 'audio'
    default: return 'document' // 'file', 'fallback', anything else
  }
}

function toMessage(ev: MessagingEvent, selfId?: string): InboundMessage<MessagingEvent> {
  const chatId = ev.sender?.id ?? ''
  const m = ev.message ?? {}
  const attach = m.attachments?.[0]
  let type: MessageType = m.text != null ? 'text' : 'unknown'
  let body = m.text ?? ''
  let media: MediaRef | undefined

  if (attach) {
    type = attachType(attach.type)
    body = m.text ?? '' // Messenger attachments carry no caption; text doubles as one
    media = {
      kind: type as MediaRef['kind'],
      mimetype: ATTACH_MIME[attach.type ?? ''] ?? 'application/octet-stream',
      token: attach.payload?.url,
    }
  }

  return {
    ref: { id: m.mid ?? '', chatId, native: ev },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: chatId },
    from: chatId,
    sender: chatId,
    chatId,
    senderId: chatId,
    isGroup: false,
    isBroadcast: false,
    fromMe: !!selfId && chatId === selfId,
    type,
    body,
    timestamp: ev.timestamp ?? 0,
    mentions: [],
    media,
    raw: ev,
  }
}

function toInteraction(
  ev: MessagingEvent,
  interactionId: string,
  data: string,
): InboundEvent {
  const chatId = ev.sender?.id ?? ''
  return {
    kind: 'interaction',
    interaction: {
      interactionId,
      ref: { id: interactionId, chatId, native: ev },
      chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: chatId },
      from: chatId, sender: chatId, chatId, senderId: chatId,
      isGroup: false,
      kind: 'button',
      data,
      timestamp: ev.timestamp ?? 0,
      raw: ev,
    },
  }
}

/**
 * Parse a full `page` webhook body into a flat list of events.
 *
 * Precedence inside a `message`: reaction → quick_reply → attachment → text.
 * `postback`, `opt_in` and `referral` surface as `button` interactions (the
 * payload the bot set on the control, or the referral param). Delivery/read
 * webhooks (`message_deliveries`/`message_reads`) are not normalized here — use
 * `markRead`/`typing` for the outbound side.
 */
export function parseInbound(body: PageWebhookBody, selfId?: string): InboundEvent[] {
  const events: InboundEvent[] = []
  if (body.object !== 'page') return events

  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      if (!ev.sender?.id) continue
      const chatId = ev.sender.id

      if (ev.message) {
        const m = ev.message
        // Echoes are the Page's OWN outbound messages replayed back to us. Their
        // `sender.id` is the Page (not the user), so keeping them would corrupt the
        // conversation key and risk an echo loop. Drop them — consistent with the
        // Instagram provider and with core's fromMe filter.
        if (m.is_echo) continue
        // Reactions → reaction events.
        if (m.reaction) {
          events.push({
            kind: 'reaction',
            reaction: {
              ref: { id: m.reaction.mid ?? '', chatId, native: ev },
              emoji: m.reaction.reaction ?? m.reaction.emoji ?? '',
              senderId: chatId,
              removed: m.reaction.action === 'remove',
            },
          })
          continue
        }
        // Quick replies → button interactions.
        if (m.quick_reply?.payload != null) {
          events.push(toInteraction(ev, m.mid ?? '', m.quick_reply.payload))
          continue
        }
        events.push({ kind: 'message', message: toMessage(ev, selfId) })
        continue
      }

      if (ev.postback) {
        events.push(toInteraction(ev, ev.postback.mid ?? '', ev.postback.payload ?? ''))
        continue
      }
      if (ev.optin) {
        events.push(toInteraction(ev, ev.optin.user_ref ?? chatId, ev.optin.payload ?? ev.optin.ref ?? ''))
        continue
      }
      if (ev.referral) {
        events.push(toInteraction(ev, chatId, ev.referral.ref ?? ''))
        continue
      }
    }
  }
  return events
}
