/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to a
 * wppconnect-server request (`POST /api/{session}/<endpoint>` + JSON body).
 *
 * `buttons`, `list` and `card` degrade to numbered text (WhatsApp Web has no
 * reliable native controls). `template` throws {@link UnsupportedContentError};
 * `native` with `provider: 'wppconnect'` posts `{ endpoint, body }` verbatim.
 */

import { UnsupportedContentError, type OutboundContent, type SendOptions } from '@bot-wa/core'
import { isGroupJid, isLidJid } from './identity.js'
import { resolveMedia, toDataUri } from './media.js'
import { isRecord } from './rest.js'

export interface WppOutbound {
  /** Endpoint under `/api/{session}/` (e.g. `send-message`). */
  endpoint: string
  body: Record<string, unknown>
}

export function numberedMenu(text: string, rows: Array<{ title: string }>, footer?: string): string {
  const menu = rows.map((r, i) => `${i + 1}) ${r.title}`).join('\n')
  return [text, '', menu, footer ? `\n${footer}` : ''].filter(Boolean).join('\n')
}

/** `phone` + addressing flags wppconnect-server expects for a chat id. */
export function target(chatId: string): Record<string, unknown> {
  return { phone: chatId, isGroup: isGroupJid(chatId), ...(isLidJid(chatId) ? { isLid: true } : {}) }
}

const digits = (phone: string): string => phone.replace(/[^\d]/g, '')

export async function toOutbound(chatId: string, content: OutboundContent, options: SendOptions = {}): Promise<WppOutbound> {
  const to = target(chatId)
  const quotedId = options.quoted?.id
  const text = (message: string): WppOutbound => ({
    endpoint: 'send-message',
    body: {
      ...to,
      message,
      ...(quotedId || options.mentions?.length
        ? { options: { ...(quotedId ? { quotedMsg: quotedId } : {}), ...(options.mentions?.length ? { mentionedList: options.mentions } : {}) } }
        : {}),
    },
  })
  const quote = quotedId ? { quotedMessageId: quotedId } : {}

  switch (content.kind) {
    case 'text':
      return text(content.text)
    case 'image':
    case 'video':
    case 'audio':
    case 'document': {
      const filename = content.kind === 'document' ? content.filename : undefined
      const mimetype = content.kind === 'document' ? content.mimetype : undefined
      const media = await resolveMedia(content.kind, content.media, { filename, mimetype })
      const caption = 'caption' in content ? content.caption : undefined
      return {
        endpoint: 'send-file',
        body: {
          ...to,
          ...('url' in media ? { path: media.url } : { base64: toDataUri(media) }),
          filename: media.filename ?? content.kind,
          ...(caption ? { caption } : {}),
          ...quote,
        },
      }
    }
    case 'voice': {
      const media = await resolveMedia('voice', content.media)
      return 'url' in media
        ? { endpoint: 'send-voice', body: { ...to, path: media.url, ...quote } }
        : { endpoint: 'send-voice-base64', body: { ...to, base64Ptt: toDataUri(media), ...quote } }
    }
    case 'sticker': {
      const media = await resolveMedia('sticker', content.media)
      return { endpoint: 'send-sticker', body: { ...to, path: toDataUri(media) } }
    }
    case 'location':
      return { endpoint: 'send-location', body: { ...to, lat: content.lat, lng: content.lng, title: content.name ?? '', address: content.address ?? '' } }
    case 'contact':
      return { endpoint: 'contact-vcard', body: { ...to, contactsId: `${digits(content.phone)}@c.us`, name: content.displayName ?? content.phone } }
    case 'poll':
      return {
        endpoint: 'send-poll-message',
        body: { ...to, name: content.question, choices: content.options, options: { selectableCount: content.multiSelect ? content.options.length : 1 } },
      }
    case 'reaction':
      return { endpoint: 'react-message', body: { msgId: content.target.id, reaction: content.emoji } }
    case 'buttons':
      return text(numberedMenu(content.text, content.buttons, content.footer))
    case 'list':
      return text(numberedMenu(content.text, content.sections.flatMap((s) => s.rows), content.footer))
    case 'card': {
      const lines = [content.title, content.body].filter(Boolean).join('\n')
      const caption = content.buttons?.length ? numberedMenu(lines, content.buttons) : lines
      if (content.imageUrl) return { endpoint: 'send-file', body: { ...to, path: content.imageUrl, filename: 'card', caption, ...quote } }
      return text(caption)
    }
    case 'native': {
      if (content.provider !== 'wppconnect') throw new UnsupportedContentError('native', `WPPConnectProvider cannot send native content for provider '${content.provider}'`)
      const payload = content.payload
      if (!isRecord(payload) || typeof payload.endpoint !== 'string' || !/^[a-z0-9-]+$/.test(payload.endpoint)) {
        throw new UnsupportedContentError('native', "WPPConnect native payload must be { endpoint: 'send-list-message', body: {...} }")
      }
      return { endpoint: payload.endpoint, body: { ...to, ...(isRecord(payload.body) ? payload.body : {}) } }
    }
    case 'template':
      throw new UnsupportedContentError('template', 'Templates are a WhatsApp Cloud API feature; WPPConnect (WhatsApp Web) cannot send them')
    default: {
      const kind = (content as { kind: OutboundContent['kind'] }).kind
      throw new UnsupportedContentError(kind)
    }
  }
}
