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
  InboundLocation,
  InboundMessage,
  MediaRef,
  MessageType,
} from '@botmesh/core'
import { toInboundLocation } from '@botmesh/core'

/* Loose Messenger webhook shapes (only the fields we read). */

export interface MessengerAttachment {
  type?: string // 'image' | 'video' | 'audio' | 'file' | 'location' | 'fallback'
  /** `coordinates` is set on a `location` attachment (when Meta still sends one). */
  payload?: { url?: string; title?: string; coordinates?: { lat?: number; long?: number } }
}

export interface MessengerMessage {
  mid?: string
  text?: string
  attachments?: MessengerAttachment[]
  quick_reply?: { payload?: string }
  /** Present when the user replied to a specific message. */
  reply_to?: { mid?: string }
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
    case 'location': return 'location'
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
  let location: InboundLocation | undefined

  if (attach) {
    type = attachType(attach.type)
    body = m.text ?? '' // Messenger attachments carry no caption; text doubles as one
    // A shared location has no downloadable bytes.
    if (type === 'location') {
      body = m.text ?? attach.payload?.title ?? ''
      const c = attach.payload?.coordinates
      location = toInboundLocation({ latitude: c?.lat, longitude: c?.long, name: attach.payload?.title })
    } else {
      media = {
        kind: type as MediaRef['kind'],
        mimetype: ATTACH_MIME[attach.type ?? ''] ?? 'application/octet-stream',
        token: attach.payload?.url,
      }
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
    ...(location ? { location } : {}),
    ...(m.reply_to?.mid ? { quoted: { ref: { id: m.reply_to.mid, chatId } } } : {}),
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
 * Id for an event that carries no `mid` (opt-in, referral). Core dedupes inbound
 * events by `chatId` + id, so the id must be unique per logical event and stable
 * across redelivery: the event kind plus its webhook `timestamp` (epoch ms,
 * identical on a Meta retry) is both. Never a per-user constant (PSID,
 * `user_ref`) — that would drop every later referral/opt-in of the same user as
 * a duplicate. Without a timestamp, `''` opts the event out of deduplication.
 */
function eventScopedId(kind: 'optin' | 'referral', ev: MessagingEvent): string {
  return typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp) ? `${kind}:${ev.timestamp}` : ''
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
        events.push(toInteraction(ev, eventScopedId('optin', ev), ev.optin.payload ?? ev.optin.ref ?? ''))
        continue
      }
      if (ev.referral) {
        events.push(toInteraction(ev, eventScopedId('referral', ev), ev.referral.ref ?? ''))
        continue
      }
    }
  }
  return events
}
