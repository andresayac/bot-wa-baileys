/**
 * Twilio webhook params → normalized `InboundEvent`s.
 *
 * One webhook carries one of:
 *  - an incoming message (WhatsApp or SMS/MMS): `MessageSid`, `From`, `To`,
 *    `Body`, `NumMedia` + `MediaUrl{N}`/`MediaContentType{N}`, WhatsApp extras
 *    (`ProfileName`, `WaId`, `ButtonPayload`, `Latitude`…);
 *  - a status callback for an outgoing message: `MessageStatus` + `MessageSid`.
 *
 * MEDIA: a message with several attachments (`NumMedia` > 1, up to 10) becomes
 * one `InboundMessage` per item, in order. The first keeps `ref.id` =
 * MessageSid and the `Body`; item i gets `ref.id` = `${MessageSid}:${i}` and an
 * empty body (unique per item, identical on a webhook retry).
 *
 * IDENTITY: `chatId` = `senderId` = Twilio's `From` exactly as sent
 * (`whatsapp:+15551234567` for WhatsApp, `+15551234567` for SMS). Twilio
 * already resolves the address, so the same person always yields the same id
 * per channel; WhatsApp and SMS are deliberately different chats.
 */

import { toInboundLocation } from '@botmesh/core'
import type { InboundEvent, InboundLocation, MediaRef, MessageType } from '@botmesh/core'
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
  const media = mediaItems(params)
  let location: InboundLocation | undefined
  if (media.length === 0 && one(params, 'Latitude') !== undefined && one(params, 'Longitude') !== undefined) {
    type = 'location'
    body = body || (one(params, 'Address') ?? one(params, 'Label') ?? '')
    location = toInboundLocation({
      latitude: one(params, 'Latitude'), longitude: one(params, 'Longitude'),
      name: one(params, 'Label'), address: one(params, 'Address'),
    })
  }

  const repliedSid = one(params, 'OriginalRepliedMessageSid')
  const repliedSender = one(params, 'OriginalRepliedMessageSender')
  const quoted = repliedSid ? { quoted: { ref: { id: repliedSid, chatId: from }, ...(repliedSender ? { senderId: repliedSender } : {}) } } : {}
  const message = (id: string, extra: { type: MessageType; body: string; media?: MediaRef; location?: InboundLocation }): InboundEvent<TwilioWebhookParams> => ({
    kind: 'message',
    message: {
      ref: id === sid ? ref : { ...ref, id },
      chat,
      senderInfo,
      from, sender: from, chatId: from, senderId: from,
      isGroup: false,
      isBroadcast: false,
      fromMe: false,
      type: extra.type,
      body: extra.body,
      timestamp,
      mentions: [],
      ...quoted,
      ...(extra.media ? { media: extra.media } : {}),
      ...(extra.location ? { location: extra.location } : {}),
      raw: params,
    },
  })

  if (media.length === 0) return { inbound, events: [message(sid, { type, body, ...(location ? { location } : {}) })] }
  // One message per media item (Twilio MMS / WhatsApp can carry up to 10). The
  // first keeps the MessageSid and the Body; the rest get `${sid}:${i}` (unique
  // and stable across webhook retries, so dedupe works) and an empty body.
  return {
    inbound,
    events: media.map((item, n) => message(n === 0 ? sid : `${sid}:${item.index}`, {
      type: item.ref.kind,
      body: n === 0 ? body : '',
      media: item.ref,
    })),
  }
}

/** Twilio's documented ceiling of media per message. */
const MAX_MEDIA = 10

/** `MediaUrl{i}` / `MediaContentType{i}` for i < NumMedia (capped), skipping empty slots. */
function mediaItems(params: TwilioWebhookParams): Array<{ index: number; ref: MediaRef }> {
  const declared = Number(one(params, 'NumMedia') ?? '0')
  const count = Number.isFinite(declared) ? Math.min(Math.max(Math.trunc(declared), 0), MAX_MEDIA) : 0
  const out: Array<{ index: number; ref: MediaRef }> = []
  for (let i = 0; i < count; i++) {
    const url = one(params, `MediaUrl${i}`)
    if (!url) continue
    const mimetype = one(params, `MediaContentType${i}`)
    const kind = mediaKind(mimetype)
    out.push({ index: i, ref: { kind, ...(mimetype ? { mimetype } : {}), token: { url } } })
  }
  return out
}
