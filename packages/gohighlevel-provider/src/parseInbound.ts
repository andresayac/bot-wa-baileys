/**
 * HighLevel webhook body → normalized `InboundEvent`s.
 *
 * Handled: `InboundMessage` (SMS, WhatsApp, Email, FB, IG, Live chat, GMB,
 * Custom) → `message`; `InboundMessage` with `messageType: 'CALL'` → `call`.
 * Everything else (`OutboundMessage` echoes, contact/opportunity events…) is
 * ignored: those are CRM events, not conversation input.
 *
 * IDENTITY: `chatId` = `senderId` = the HighLevel `contactId`. HighLevel
 * already merges a person's phone, email and social handles into one contact,
 * so every channel of the same contact lands in the same chat; the channel of
 * each message is kept in `chat.platformData.channel` (and used to reply).
 */

import type { InboundEvent, MediaRef, MessageType } from '@bot-wa/core'
import type { GhlChannel, GhlWebhookBody } from './types.js'

const CHANNEL_ALIASES: Record<string, GhlChannel> = {
  sms: 'SMS', type_sms: 'SMS',
  whatsapp: 'WhatsApp', type_whatsapp: 'WhatsApp',
  email: 'Email', type_email: 'Email',
  fb: 'FB', facebook: 'FB', type_facebook: 'FB',
  ig: 'IG', instagram: 'IG', type_instagram: 'IG',
  live_chat: 'Live_Chat', 'live chat': 'Live_Chat', livechat: 'Live_Chat', type_live_chat: 'Live_Chat',
  gmb: 'GMB', type_gmb: 'GMB',
  custom: 'Custom', type_custom_sms: 'Custom', type_custom_provider_sms: 'Custom',
}

/** HighLevel `messageType` / `messageTypeString` → send `type`, or undefined when unknown. */
export function channelOf(body: Pick<GhlWebhookBody, 'messageType' | 'messageTypeString'>): GhlChannel | undefined {
  for (const raw of [body.messageType, body.messageTypeString]) {
    if (typeof raw !== 'string' || !raw) continue
    const hit = CHANNEL_ALIASES[raw.toLowerCase()]
    if (hit) return hit
  }
  return undefined
}

function isCall(body: GhlWebhookBody): boolean {
  const t = `${body.messageType ?? ''}|${body.messageTypeString ?? ''}`.toUpperCase()
  return t.includes('CALL') || t.includes('VOICEMAIL')
}

/** Media kind from an attachment URL's extension. */
export function attachmentKind(url: string): MediaRef['kind'] {
  let path = url
  try { path = new URL(url).pathname } catch { /* keep raw */ }
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(ext)) return 'image'
  if (['mp4', 'mov', '3gp', 'webm', 'm4v', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'ogg', 'oga', 'opus', 'm4a', 'wav', 'amr', 'aac'].includes(ext)) return 'audio'
  return 'document'
}

function timestampOf(body: GhlWebhookBody, now: () => number): number {
  const parsed = body.dateAdded ? Date.parse(body.dateAdded) : NaN
  return Number.isFinite(parsed) ? parsed : now()
}

export interface ParsedGhl {
  events: InboundEvent<GhlWebhookBody>[]
  /** The channel a contact last wrote on (reply routing). */
  channel?: { contactId: string; channel: GhlChannel }
}

export function parseInbound(body: GhlWebhookBody, now: () => number = Date.now): ParsedGhl {
  if (body.type !== 'InboundMessage') return { events: [] }
  if (body.direction !== undefined && body.direction !== 'inbound') return { events: [] }
  const contactId = typeof body.contactId === 'string' && body.contactId ? body.contactId : undefined
  if (!contactId) return { events: [] }
  const id = body.messageId ?? body.webhookId ?? ''

  if (isCall(body)) {
    return {
      events: [{
        kind: 'call',
        event: { id, from: contactId, status: body.callStatus ?? body.status ?? 'unknown', chatId: contactId, isGroup: false },
      }],
    }
  }

  const channel = channelOf(body)
  const platformData: Record<string, unknown> = {
    ...(channel ? { channel } : {}),
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    ...(body.locationId ? { locationId: body.locationId } : {}),
    ...(body.from ? { from: body.from } : {}),
    ...(body.to ? { to: body.to } : {}),
  }
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a): a is string => typeof a === 'string' && a.length > 0) : []
  let type: MessageType = 'text'
  let media: MediaRef | undefined
  if (attachments.length > 0) {
    const kind = attachmentKind(attachments[0]!)
    type = kind
    media = { kind, token: { url: attachments[0] } }
  }
  const text = typeof body.body === 'string' ? body.body : ''

  return {
    ...(channel ? { channel: { contactId, channel } } : {}),
    events: [{
      kind: 'message',
      message: {
        ref: { id, chatId: contactId, native: { messageId: body.messageId, conversationId: body.conversationId, channel } },
        chat: { id: contactId, kind: 'dm', isGroup: false, isBroadcast: false, platformData },
        senderInfo: { id: contactId, platformData: { ...(body.from ? { address: body.from } : {}), ...(channel ? { channel } : {}) } },
        from: contactId, sender: contactId, chatId: contactId, senderId: contactId,
        isGroup: false,
        isBroadcast: false,
        fromMe: false,
        type,
        body: text,
        timestamp: timestampOf(body, now),
        mentions: [],
        ...(media ? { media } : {}),
        raw: body,
      },
    }],
  }
}
