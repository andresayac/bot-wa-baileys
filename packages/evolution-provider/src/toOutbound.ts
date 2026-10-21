/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to an Evolution
 * API v2 request (`POST /message/<endpoint>/{instance}` + JSON body).
 *
 * WhatsApp Web has no reliable native buttons/lists, so `buttons`, `list` and
 * `card` degrade to numbered text (same as `@botmesh/baileys`). `template` is a
 * Cloud-API-only concept and throws {@link UnsupportedContentError}. `native`
 * with `provider: 'evolution'` posts `{ endpoint, body }` verbatim.
 */

import { UnsupportedContentError, type MessageRef, type OutboundContent } from '@botmesh/core'
import { isRecord, resolveMedia } from '@botmesh/wa-gateway-kit'
import type { EvolutionMessageKey } from './types.js'

export interface EvolutionOutbound {
  /** Endpoint under `/message/` (e.g. `sendText`). */
  endpoint: string
  body: Record<string, unknown>
}

export function numberedMenu(text: string, rows: Array<{ title: string }>, footer?: string): string {
  const menu = rows.map((r, i) => `${i + 1}) ${r.title}`).join('\n')
  return [text, '', menu, footer ? `\n${footer}` : ''].filter(Boolean).join('\n')
}

/** Rebuild a Baileys key for a ref: the native key when we produced it, a best effort otherwise. */
export function keyFromRef(ref: MessageRef): EvolutionMessageKey {
  const native = isRecord(ref.native) ? (ref.native as EvolutionMessageKey) : undefined
  return {
    remoteJid: native?.remoteJid ?? ref.chatId,
    fromMe: native?.fromMe ?? false,
    id: native?.id ?? ref.id,
    ...(native?.participant ? { participant: native.participant } : {}),
  }
}

const digits = (phone: string): string => phone.replace(/[^\d]/g, '')

export async function toOutbound(chatId: string, content: OutboundContent): Promise<EvolutionOutbound> {
  const number = chatId
  switch (content.kind) {
    case 'text':
      return { endpoint: 'sendText', body: { number, text: content.text } }
    case 'image':
    case 'video':
    case 'document': {
      const filename = content.kind === 'document' ? content.filename : undefined
      const mimetype = content.kind === 'document' ? content.mimetype : undefined
      const media = await resolveMedia(content.kind, content.media, { filename, mimetype })
      return {
        endpoint: 'sendMedia',
        body: {
          number,
          mediatype: content.kind,
          media: 'url' in media ? media.url : media.base64,
          ...(media.mimetype ? { mimetype: media.mimetype } : {}),
          ...(content.caption ? { caption: content.caption } : {}),
          ...(media.filename ? { fileName: media.filename } : {}),
        },
      }
    }
    case 'audio': {
      const media = await resolveMedia('audio', content.media)
      return {
        endpoint: 'sendMedia',
        body: { number, mediatype: 'audio', media: 'url' in media ? media.url : media.base64, ...(media.mimetype ? { mimetype: media.mimetype } : {}) },
      }
    }
    case 'voice': {
      const media = await resolveMedia('voice', content.media)
      return { endpoint: 'sendWhatsAppAudio', body: { number, audio: 'url' in media ? media.url : media.base64 } }
    }
    case 'sticker': {
      const media = await resolveMedia('sticker', content.media)
      return { endpoint: 'sendSticker', body: { number, sticker: 'url' in media ? media.url : media.base64 } }
    }
    case 'location':
      return {
        endpoint: 'sendLocation',
        body: { number, latitude: content.lat, longitude: content.lng, name: content.name ?? '', address: content.address ?? '' },
      }
    case 'contact':
      return {
        endpoint: 'sendContact',
        body: { number, contact: [{ fullName: content.displayName ?? content.phone, wuid: digits(content.phone), phoneNumber: content.phone }] },
      }
    case 'poll':
      return {
        endpoint: 'sendPoll',
        body: { number, name: content.question, selectableCount: content.multiSelect ? content.options.length : 1, values: content.options },
      }
    case 'reaction':
      return { endpoint: 'sendReaction', body: { key: keyFromRef(content.target), reaction: content.emoji } }
    case 'buttons':
      return { endpoint: 'sendText', body: { number, text: numberedMenu(content.text, content.buttons, content.footer) } }
    case 'list':
      return { endpoint: 'sendText', body: { number, text: numberedMenu(content.text, content.sections.flatMap((s) => s.rows), content.footer) } }
    case 'card': {
      const lines = [content.title, content.body].filter(Boolean).join('\n')
      if (content.imageUrl) {
        return { endpoint: 'sendMedia', body: { number, mediatype: 'image', media: content.imageUrl, caption: content.buttons?.length ? numberedMenu(lines, content.buttons) : lines } }
      }
      return { endpoint: 'sendText', body: { number, text: content.buttons?.length ? numberedMenu(lines, content.buttons) : lines } }
    }
    case 'native': {
      if (content.provider !== 'evolution') throw new UnsupportedContentError('native', `EvolutionProvider cannot send native content for provider '${content.provider}'`)
      const payload = content.payload
      if (!isRecord(payload) || typeof payload.endpoint !== 'string' || !/^[A-Za-z]+$/.test(payload.endpoint)) {
        throw new UnsupportedContentError('native', "Evolution native payload must be { endpoint: 'sendButtons', body: {...} }")
      }
      const body = isRecord(payload.body) ? payload.body : {}
      return { endpoint: payload.endpoint, body: { number, ...body } }
    }
    case 'template':
      throw new UnsupportedContentError('template', 'Templates are a WhatsApp Cloud API feature; Evolution (Baileys) cannot send them')
    default: {
      const kind = (content as { kind: OutboundContent['kind'] }).kind
      throw new UnsupportedContentError(kind)
    }
  }
}
