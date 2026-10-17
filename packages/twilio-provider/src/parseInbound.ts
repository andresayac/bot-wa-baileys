/**
 * Twilio webhook params → normalized `InboundEvent`s.
 *
 * One webhook carries one of:
 *  - an incoming message (WhatsApp or SMS/MMS): `MessageSid`, `From`, `To`,
 *    `Body`, `NumMedia` + `MediaUrl{N}`/`MediaContentType{N}`, WhatsApp extras
 *    (`ProfileName`, `WaId`, `ButtonPayload`, `Latitude`…);
 *  - a status callback for an outgoing message: `MessageStatus` + `MessageSid`.
 *
 * IDENTITY: `chatId` = `senderId` = Twilio's `From` exactly as sent
 * (`whatsapp:+15551234567` for WhatsApp, `+15551234567` for SMS). Twilio
 * already resolves the address, so the same person always yields the same id
 * per channel; WhatsApp and SMS are deliberately different chats.
 */

import type { InboundEvent, MediaRef, MessageType } from '@bot-wa/core'
import type { TwilioWebhookParams } from './types.js'

function one(params: TwilioWebhookParams, key: string): string | undefined {
  const value = params[key]
  const out = Array.isArray(value) ? value[0] : value
  return out === undefined || out === '' ? undefined : out
}

/** `whatsapp:+1…` → `'whatsapp'`; a bare number → `'sms'`; other prefixes kept (`messenger`, `rcs`). */
export function channelOf(address: string): string {
  const colon = address.indexOf(':')
  return colon > 0 ? address.slice(0, colon).toLowerCase() : 'sms'
}

function mediaKind(mime: string | undefined): MediaRef['kind'] {
  const type = (mime ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return 'document'
}

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  undelivered: 'failed',
}

/** Delivery states that are only bookkeeping (no neutral equivalent). */
const SILENT_STATUSES = new Set(['queued', 'accepted', 'scheduled', 'sending', 'canceled', 'partially_delivered'])

export interface ParsedTwilio {
  events: InboundEvent<TwilioWebhookParams>[]
  /** For an incoming message: the chat, the number it reached, and its SID (reply routing + typing). */
  inbound?: { chatId: string; to?: string; messageSid: string }
}

export function parseInbound(params: TwilioWebhookParams, now: () => number = Date.now): ParsedTwilio {
  const sid = one(params, 'MessageSid') ?? one(params, 'SmsMessageSid') ?? one(params, 'SmsSid')
  const status = (one(params, 'MessageStatus') ?? one(params, 'SmsStatus'))?.toLowerCase()

  // Status callback for an outgoing message.
  if (status && status !== 'received' && status !== 'receiving') {
    const mapped = STATUS_MAP[status]
    if (!mapped || !sid) return { events: [] }
    const recipient = one(params, 'To')
    const errorCode = one(params, 'ErrorCode')
    const errorMessage = one(params, 'ErrorMessage')
    return {
      events: [{
        kind: 'status',
        status: {
          ref: { id: sid, chatId: recipient ?? '', native: params },
          status: mapped,
          ...(recipient ? { recipient } : {}),
          ...(errorCode || errorMessage
            ? { error: { ...(errorCode ? { code: Number(errorCode) || errorCode } : {}), ...(errorMessage ? { message: errorMessage } : {}) } }
            : {}),
          timestamp: now(),
        },
      }],
    }
  }
  if (status && SILENT_STATUSES.has(status)) return { events: [] }

  const from = one(params, 'From')
  if (!from || !sid) return { events: [] }
  const to = one(params, 'To')
  const channel = channelOf(from)
  const chat = { id: from, kind: 'dm' as const, isGroup: false, isBroadcast: false, platformData: { channel, ...(to ? { to } : {}) } }
  const profileName = one(params, 'ProfileName')
  const waId = one(params, 'WaId')
  const senderInfo = {
    id: from,
    ...(profileName ? { displayName: profileName } : {}),
    platformData: { channel, ...(waId ? { waId } : {}) },
  }
  const timestamp = now()
  const ref = { id: sid, chatId: from, native: { sid, channel } }
  const inbound = { chatId: from, ...(to ? { to } : {}), messageSid: sid }

  // Quick-reply / list-picker click → interaction.
  const buttonPayload = one(params, 'ButtonPayload')
  const listId = one(params, 'ListId')
  if (buttonPayload !== undefined || listId !== undefined) {
    return {
      inbound,
      events: [{
        kind: 'interaction',
        interaction: {
          interactionId: sid,
          ref,
          chat,
          senderInfo,
          from, sender: from, chatId: from, senderId: from,
          isGroup: false,
          kind: listId !== undefined ? 'list' : 'button',
          data: (listId ?? buttonPayload) as string,
          timestamp,
          raw: params,
        },
      }],
    }
  }

  let type: MessageType = 'text'
  let body = one(params, 'Body') ?? ''
  let media: MediaRef | undefined
  const numMedia = Number(one(params, 'NumMedia') ?? '0')
  const mediaUrl = one(params, 'MediaUrl0')
  if (numMedia > 0 && mediaUrl) {
    const mimetype = one(params, 'MediaContentType0')
    const kind = mediaKind(mimetype)
    type = kind
    media = { kind, ...(mimetype ? { mimetype } : {}), token: { url: mediaUrl } }
  } else if (one(params, 'Latitude') !== undefined && one(params, 'Longitude') !== undefined) {
    type = 'location'
    body = body || (one(params, 'Address') ?? one(params, 'Label') ?? '')
  }

  const repliedSid = one(params, 'OriginalRepliedMessageSid')
  const repliedSender = one(params, 'OriginalRepliedMessageSender')

  return {
    inbound,
    events: [{
      kind: 'message',
      message: {
        ref,
        chat,
        senderInfo,
        from, sender: from, chatId: from, senderId: from,
        isGroup: false,
        isBroadcast: false,
        fromMe: false,
        type,
        body,
        timestamp,
        mentions: [],
        ...(repliedSid ? { quoted: { ref: { id: repliedSid, chatId: from }, ...(repliedSender ? { senderId: repliedSender } : {}) } } : {}),
        ...(media ? { media } : {}),
        raw: params,
      },
    }],
  }
}
