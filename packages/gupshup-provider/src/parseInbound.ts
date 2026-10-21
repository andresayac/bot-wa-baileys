/**
 * Gupshup v2 callback → normalized `InboundEvent`s.
 *
 *  - `message` → `message` (text, image, video, audio, file, sticker,
 *    location, contact), `interaction` (quick-reply / button / list replies),
 *    or `reaction`.
 *  - `message-event` → `status` (`sent` / `delivered` / `read` / `failed`;
 *    `enqueued` and `deleted` are bookkeeping and dropped).
 *  - `user-event`, `billing-event`, … → ignored.
 *
 * IDENTITY: `chatId` = `senderId` = the customer's number as Gupshup reports
 * it (`sender.phone`, falling back to `source`): digits with country code, no
 * `+`. That is also the `destination` the send API expects, so a reply goes to
 * exactly the id that came in.
 *
 * MESSAGE IDS: inbound refs carry the WhatsApp message id (`payload.id`).
 * Outbound refs carry the Gupshup message id (`messageId` from the send API =
 * `gsId` in callbacks), so status events and replies-to-our-messages are keyed
 * by `gsId` when present.
 */

import { toInboundLocation } from '@botmesh/core'
import type { InboundEvent, InboundLocation, MediaRef, MessageType } from '@botmesh/core'
import type { GupshupCallback, GupshupEventPayload, GupshupMessagePayload } from './types.js'

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

const MEDIA_TYPES: Record<string, MediaRef['kind']> = {
  image: 'image', video: 'video', audio: 'audio', file: 'document', document: 'document', sticker: 'sticker',
}

const INTERACTIVE_TYPES = new Set(['quick_reply', 'button_reply', 'list_reply'])

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed',
}

export function parseInbound(body: GupshupCallback, now: () => number = Date.now): InboundEvent<GupshupCallback>[] {
  const timestamp = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? body.timestamp : now()

  if (body.type === 'message-event') {
    const ev = (body.payload ?? {}) as GupshupEventPayload
    const status = STATUS_MAP[String(ev.type ?? '')]
    const id = str(ev.gsId) ?? str(ev.id)
    if (!status || !id) return []
    const recipient = str(ev.destination)
    const code = ev.payload?.code
    const reason = ev.payload?.reason
    return [{
      kind: 'status',
      status: {
        ref: { id, chatId: recipient ?? '', native: { gsId: ev.gsId, id: ev.id } },
        status,
        ...(recipient ? { recipient } : {}),
        ...(status === 'failed' ? { error: { ...(code !== undefined ? { code } : {}), ...(reason ? { message: reason } : {}) } } : {}),
        timestamp,
      },
    }]
  }

  if (body.type !== 'message') return []
  const msg = (body.payload ?? {}) as GupshupMessagePayload
  const from = str(msg.sender?.phone) ?? str(msg.source)
  const id = str(msg.id) ?? ''
  if (!from) return []
  const inner = msg.payload ?? {}
  const type = String(msg.type ?? '')
  const chat = { id: from, kind: 'dm' as const, isGroup: false, isBroadcast: false, platformData: { app: body.app } }
  const senderName = str(msg.sender?.name)
  const senderInfo = {
    id: from,
    ...(senderName ? { displayName: senderName } : {}),
    platformData: {
      ...(msg.sender?.country_code ? { countryCode: msg.sender.country_code } : {}),
      ...(msg.sender?.dial_code ? { dialCode: msg.sender.dial_code } : {}),
    },
  }
  const ref = { id, chatId: from, native: { id: msg.id } }
  const base = { from, sender: from, chatId: from, senderId: from, isGroup: false }

  if (type === 'reaction') {
    const target = str(inner['gsId']) ?? str(inner['id'])
    if (!target) return []
    const emoji = str(inner['emoji']) ?? ''
    return [{ kind: 'reaction', reaction: { ref: { id: target, chatId: from }, emoji, senderId: from, ...(emoji ? {} : { removed: true }) } }]
  }

  const isButtonText = type === 'text' && inner['type'] === 'button'
  if (INTERACTIVE_TYPES.has(type) || isButtonText) {
    const data =
      str(inner['postbackText']) ?? str(inner['payload']) ?? str(inner['id']) ?? str(inner['reply']) ?? str(inner['title']) ?? str(inner['text']) ?? ''
    return [{
      kind: 'interaction',
      interaction: {
        interactionId: id,
        ref,
        chat,
        senderInfo,
        ...base,
        kind: type === 'list_reply' ? 'list' : 'button',
        data,
        timestamp,
        raw: body,
      },
    }]
  }

  let messageType: MessageType = 'unknown'
  let text = ''
  let media: MediaRef | undefined
  let location: InboundLocation | undefined
  const mediaKind = MEDIA_TYPES[type]
  if (type === 'text') {
    messageType = 'text'
    text = str(inner['text']) ?? ''
  } else if (mediaKind) {
    messageType = mediaKind
    text = str(inner['caption']) ?? ''
    const url = str(inner['url'])
    const mimetype = str(inner['contentType']) ?? str(inner['content-type'])
    const filename = str(inner['name'])
    if (url) {
      media = {
        kind: mediaKind,
        ...(mimetype ? { mimetype } : {}),
        ...(filename ? { filename } : {}),
        token: { url, ...(typeof inner['urlExpiry'] === 'number' ? { expiresAt: inner['urlExpiry'] } : {}) },
      }
    }
  } else if (type === 'location') {
    messageType = 'location'
    text = [str(inner['name']), str(inner['address'])].filter(Boolean).join(', ')
    // Gupshup sends the coordinates as strings ('19.1453658').
    location = toInboundLocation({ latitude: inner['latitude'], longitude: inner['longitude'], name: inner['name'], address: inner['address'] })
  } else if (type === 'contact') {
    messageType = 'contact'
    const contacts = Array.isArray(inner['contacts']) ? (inner['contacts'] as Array<{ name?: { formatted_name?: string } }>) : []
    text = contacts.map((c) => c.name?.formatted_name).filter(Boolean).join(', ')
  }

  const quotedId = str(msg.context?.gsId) ?? str(msg.context?.id)
  return [{
    kind: 'message',
    message: {
      ref,
      chat,
      senderInfo,
      ...base,
      isBroadcast: false,
      fromMe: false,
      type: messageType,
      body: text,
      timestamp,
      mentions: [],
      ...(quotedId ? { quoted: { ref: { id: quotedId, chatId: from, native: msg.context } } } : {}),
      ...(media ? { media } : {}),
      ...(location ? { location } : {}),
      raw: body,
    },
  }]
}
