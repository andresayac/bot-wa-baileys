/**
 * parseInbound — turn a WhatsApp Cloud API webhook body into normalized
 * {@link InboundEvent}s. Identity is `wa_id` (E.164, no '+'): stable, no LID/PN.
 */

import type {
  InboundEvent,
  InboundMessage,
  MessageType,
  MediaRef,
} from '@bot-wa/core'

/* Loose Graph webhook shapes (only the fields we read). */
interface GraphMedia { id?: string; mime_type?: string; caption?: string; filename?: string }
interface GraphMessage {
  from: string
  id: string
  timestamp?: string
  type: string
  text?: { body?: string }
  image?: GraphMedia
  video?: GraphMedia
  audio?: GraphMedia & { voice?: boolean }
  document?: GraphMedia
  sticker?: GraphMedia
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
  reaction?: { message_id?: string; emoji?: string }
  interactive?: {
    type?: string
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string; description?: string }
  }
}
interface GraphStatus {
  id?: string
  recipient_id?: string
  status?: string
  timestamp?: string
  errors?: Array<{ code?: number; title?: string }>
}
interface GraphContact { profile?: { name?: string }; wa_id?: string }
interface GraphValue {
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: GraphContact[]
  messages?: GraphMessage[]
  statuses?: GraphStatus[]
}
export interface GraphWebhookBody {
  object?: string
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: GraphValue }> }>
}

const MEDIA_BODY: Record<string, string> = {}

function mediaOf(msg: GraphMessage): { type: MessageType; body: string; ref?: MediaRef } {
  const kind = msg.type as keyof typeof mediaFields
  const field = mediaFields[kind]
  if (!field) return { type: 'unknown', body: '' }
  const m = (msg as unknown as Record<string, GraphMedia>)[field]
  if (!m) return { type: kind === 'audio' ? ((msg.audio?.voice ? 'voice' : 'audio') as MessageType) : (kind as MessageType), body: '' }
  const type: MessageType =
    kind === 'audio' ? (msg.audio?.voice ? 'voice' : 'audio')
    : (kind as MessageType)
  return {
    type,
    body: m.caption ?? '',
    ref: { kind: (type === 'voice' ? 'audio' : type) as MediaRef['kind'], mimetype: m.mime_type, filename: m.filename, token: m.id },
  }
}
const mediaFields = { image: 'image', video: 'video', audio: 'audio', document: 'document', sticker: 'sticker' } as const

function toMessage(msg: GraphMessage, pushName: string | undefined): InboundMessage<GraphMessage> {
  const chatId = msg.from
  let type: MessageType = 'unknown'
  let body = ''
  let media: MediaRef | undefined

  if (msg.type === 'text') {
    type = 'text'
    body = msg.text?.body ?? ''
  } else if (msg.type === 'location') {
    type = 'location'
  } else if (msg.type === 'contacts') {
    type = 'contact'
  } else if (msg.type in mediaFields || msg.type === 'audio') {
    const parsed = mediaOf(msg)
    type = parsed.type
    body = parsed.body
    media = parsed.ref
  }

  return {
    ref: { id: msg.id, chatId, native: msg },
    chat: { id: chatId, kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: chatId, displayName: pushName },
    from: chatId,
    sender: chatId,
    chatId,
    senderId: chatId,
    isGroup: false,
    isBroadcast: false,
    fromMe: false,
    type,
    body,
    timestamp: msg.timestamp ? Number(msg.timestamp) : 0,
    mentions: [],
    media,
    raw: msg,
  }
}

/** Parse a full webhook body into a flat list of events. */
export function parseInbound(body: GraphWebhookBody): InboundEvent[] {
  const events: InboundEvent[] = []
  if (body.object !== 'whatsapp_business_account') return events

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value) continue

      const names = new Map<string, string>()
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name)
      }

      for (const msg of value.messages ?? []) {
        const pushName = names.get(msg.from)
        // Interactive replies (button/list clicks) → interaction events.
        if (msg.type === 'interactive' && msg.interactive) {
          const reply = msg.interactive.button_reply ?? msg.interactive.list_reply
          const kind = msg.interactive.type === 'list_reply' ? 'list' : 'button'
          events.push({
            kind: 'interaction',
            interaction: {
              interactionId: msg.id,
              ref: { id: msg.id, chatId: msg.from, native: msg },
              chat: { id: msg.from, kind: 'dm', isGroup: false, isBroadcast: false },
              senderInfo: { id: msg.from, displayName: pushName },
              from: msg.from, sender: msg.from, chatId: msg.from, senderId: msg.from,
              isGroup: false,
              kind,
              data: reply?.id ?? '',
              timestamp: msg.timestamp ? Number(msg.timestamp) : 0,
              raw: msg,
            },
          })
          continue
        }
        // Reactions → reaction events.
        if (msg.type === 'reaction' && msg.reaction) {
          events.push({
            kind: 'reaction',
            reaction: {
              ref: { id: msg.reaction.message_id ?? '', chatId: msg.from, native: msg },
              emoji: msg.reaction.emoji ?? '',
              senderId: msg.from,
              removed: !msg.reaction.emoji,
            },
          })
          continue
        }
        events.push({ kind: 'message', message: toMessage(msg, pushName) })
      }

      for (const st of value.statuses ?? []) {
        const status = st.status as 'sent' | 'delivered' | 'read' | 'failed' | undefined
        if (!status) continue
        events.push({
          kind: 'status',
          status: {
            ref: { id: st.id ?? '', chatId: st.recipient_id ?? '' },
            status: status === 'sent' || status === 'delivered' || status === 'read' ? status : 'failed',
            recipient: st.recipient_id,
            error: st.errors?.[0] ? { code: st.errors[0].code, message: st.errors[0].title } : undefined,
            timestamp: st.timestamp ? Number(st.timestamp) : 0,
          },
        })
      }
    }
  }
  return events
}
