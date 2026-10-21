/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to a Telegram
 * Bot API method call: `{ method, params }` (e.g. `sendMessage {text}`).
 *
 * The provider resolves the `MediaSource` BEFORE calling this and passes the
 * outcome as {@link ResolvedTelegramMedia}:
 *  - `value` (a `file_id` or public URL) is inlined into the JSON params, and
 *  - `buffer` sets `params[mediaField] = MEDIA_UPLOAD`, telling the provider's
 *    `callApi` to send a multipart/form-data body with the bytes in that field.
 *
 * Telegram SUPPORTS polls natively (`sendPoll`), buttons via inline keyboards,
 * reactions (`setMessageReaction`) and editing (`editMessageText`). `chat_id`
 * is injected by the provider — `params` here never carries it, EXCEPT
 * `reaction`, whose target chat may differ from the send chatId.
 */

import { UnsupportedContentError, type OutboundContent } from '@botmesh/core'
import { targetOf } from './refs.js'

/** How the provider resolved a MediaSource for the Bot API. */
export interface ResolvedTelegramMedia {
  /** Telegram `file_id` or a public HTTPS URL — accepted inline in JSON params. */
  value?: string
  /** Raw bytes that must be uploaded as multipart; goes into `mediaField`. */
  buffer?: Buffer
  /** Suggested filename for the upload (documents, paths). */
  filename?: string
}

/** Sentinel placed in `params[mediaField]` when a multipart upload is required. */
export const MEDIA_UPLOAD = Symbol('telegram-media-upload')

export interface TelegramOutbound {
  /** Bot API method, e.g. 'sendMessage'. POSTed to /bot{token}/{method}. */
  method: string
  params: Record<string, unknown>
  /** When set, `params[mediaField] === MEDIA_UPLOAD` and the call is multipart. */
  mediaField?: string
}

/** Inline-keyboard button text is kept to 64 characters. */
const BTN_TEXT = 64
/** The Bot API caps `callback_data` at 64 BYTES (UTF-8), not characters. */
const CALLBACK_DATA_BYTES = 64

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a code
 * point (a cut surrogate pair or multi-byte sequence would be rejected by the
 * Bot API as BUTTON_DATA_INVALID).
 */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (bytes + n > maxBytes) break
    out += ch
    bytes += n
  }
  return out
}

function mediaParam(field: string, media: ResolvedTelegramMedia | undefined, kind: OutboundContent['kind']): Pick<TelegramOutbound, 'params' | 'mediaField'> {
  if (media?.value) return { params: { [field]: media.value } }
  if (media?.buffer) return { params: { [field]: MEDIA_UPLOAD }, mediaField: field }
  throw new UnsupportedContentError(kind, `Telegram ${kind} requires a resolvable MediaSource (url, file_id, buffer or path).`)
}

function buttonRow(b: { id: string; title: string; url?: string }): Record<string, unknown> {
  const text = b.title.slice(0, BTN_TEXT)
  return b.url
    ? { text, url: b.url }
    : { text, callback_data: truncateUtf8(b.id || b.title, CALLBACK_DATA_BYTES) }
}

function inlineKeyboard(buttons: Array<{ id: string; title: string; url?: string }>): Record<string, unknown> {
  return { inline_keyboard: buttons.map((b) => [buttonRow(b)]) }
}

/**
 * @returns the Bot API `{ method, params }` for this content. `chat_id` is NOT
 * included (the provider adds it), except for `reaction` which targets the
 * quoted message's own chat.
 */
export function toOutbound(content: OutboundContent, media?: ResolvedTelegramMedia): TelegramOutbound {
  switch (content.kind) {
    case 'text':
      return { method: 'sendMessage', params: { text: content.text } }

    case 'image': {
      const m = mediaParam('photo', media, 'image')
      return { method: 'sendPhoto', ...m, params: { ...m.params, ...(content.caption ? { caption: content.caption } : {}) } }
    }
    case 'video': {
      const m = mediaParam('video', media, 'video')
      return { method: 'sendVideo', ...m, params: { ...m.params, ...(content.caption ? { caption: content.caption } : {}) } }
    }
    case 'audio': {
      const m = mediaParam('audio', media, 'audio')
      return { method: 'sendAudio', ...m, params: { ...m.params } }
    }
    case 'voice': {
      const m = mediaParam('voice', media, 'voice')
      return { method: 'sendVoice', ...m, params: { ...m.params } }
    }
    case 'document': {
      // `filename` rides on the multipart part (media.filename), not in params.
      const m = mediaParam('document', media, 'document')
      return {
        method: 'sendDocument',
        mediaField: m.mediaField,
        params: { ...m.params, ...(content.caption ? { caption: content.caption } : {}) },
      }
    }
    case 'sticker': {
      const m = mediaParam('sticker', media, 'sticker')
      return { method: 'sendSticker', ...m, params: { ...m.params } }
    }

    case 'location':
      // A named place with an address is a venue; a bare pin stays a location
      // (sendVenue requires both title and address).
      if (content.name && content.address) {
        return {
          method: 'sendVenue',
          params: { latitude: content.lat, longitude: content.lng, title: content.name, address: content.address },
        }
      }
      return { method: 'sendLocation', params: { latitude: content.lat, longitude: content.lng } }

    case 'contact':
      return {
        method: 'sendContact',
        params: { phone_number: content.phone, first_name: content.displayName ?? content.phone },
      }

    case 'form':
      throw new UnsupportedContentError('form', 'This transport has no native forms — flow().form() asks field by field instead (capabilities.forms is not "native").')
    case 'poll':
      return {
        method: 'sendPoll',
        params: {
          question: content.question,
          options: content.options,
          allows_multiple_answers: content.multiSelect ?? false,
        },
      }

    case 'reaction':
      const target = targetOf(content.target)
      if (target.kind !== 'message') {
        throw new UnsupportedContentError('reaction', `Telegram cannot react to this message (${target.kind === 'none' ? 'no message_id' : target.kind + ' message'})`)
      }
      return {
        method: 'setMessageReaction',
        params: {
          chat_id: target.chat_id,
          message_id: target.message_id,
          reaction: content.emoji ? [{ type: 'emoji', emoji: content.emoji }] : [],
        },
      }

    case 'buttons': {
      const params: Record<string, unknown> = {
        text: content.text,
        reply_markup: inlineKeyboard(content.buttons),
      }
      return { method: 'sendMessage', params }
    }

    case 'list': {
      // Telegram has no native list control: degrade to an inline keyboard —
      // one callback button per row across all sections.
      const rows = content.sections.flatMap((s) => s.rows)
      const buttons = rows.map((r) => ({ id: r.id, title: r.title, url: undefined }))
      const text = [content.text, content.buttonText].filter(Boolean).join('\n')
      return { method: 'sendMessage', params: { text, reply_markup: inlineKeyboard(buttons) } }
    }

    case 'card': {
      const text = [content.title, content.body].filter(Boolean).join('\n')
      if (content.imageUrl) {
        return {
          method: 'sendPhoto',
          params: {
            photo: content.imageUrl,
            caption: text,
            ...(content.buttons?.length ? { reply_markup: inlineKeyboard(content.buttons) } : {}),
          },
        }
      }
      return {
        method: 'sendMessage',
        params: {
          text,
          ...(content.buttons?.length ? { reply_markup: inlineKeyboard(content.buttons) } : {}),
        },
      }
    }

    case 'native': {
      // Escape hatch: { method, params } or a bare sendMessage-params object.
      const payload = content.payload as { method?: string; params?: Record<string, unknown> } | null
      if (payload && typeof payload.method === 'string') {
        return { method: payload.method, params: payload.params ?? {} }
      }
      return { method: 'sendMessage', params: (payload ?? {}) as Record<string, unknown> }
    }

    case 'template':
      throw new UnsupportedContentError('template', 'Telegram has no template concept — use kind text/buttons/native.')
  }
}
