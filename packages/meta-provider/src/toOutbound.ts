/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to a WhatsApp
 * Cloud API message payload (the object under `type` in the Graph request).
 *
 * Media is resolved by the provider BEFORE this is called (uploaded → `id`, or
 * a URL → `link`). Cloud API supports native reply buttons, lists, templates
 * and reactions; it does NOT support poll messages (Graph error 131051), so
 * `poll` throws {@link UnsupportedContentError}.
 */

import { UnsupportedContentError, type OutboundContent } from '@bot-wa/core'

/** How the provider resolved a MediaSource for Cloud API. */
export interface ResolvedMedia {
  /** Uploaded media id (from POST /media). */
  id?: string
  /** Publicly reachable URL (used as a `link`). */
  link?: string
}

function mediaObject(media: ResolvedMedia | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (media?.id) return { id: media.id, ...extra }
  if (media?.link) return { link: media.link, ...extra }
  throw new UnsupportedContentError('image', 'Cloud API media requires an uploaded id or a public link.')
}

/**
 * @returns the message payload: `{ type, [type]: {...} }` or
 *   `{ type: 'interactive'|'template'|'reaction', ... }` — ready to spread into
 *   the Graph `/messages` request.
 */
export function toOutbound(content: OutboundContent, media?: ResolvedMedia): Record<string, unknown> {
  switch (content.kind) {
    case 'text':
      return { type: 'text', text: { body: content.text } }

    case 'image':
      return { type: 'image', image: mediaObject(media, content.caption ? { caption: content.caption } : {}) }
    case 'video':
      return { type: 'video', video: mediaObject(media, content.caption ? { caption: content.caption } : {}) }
    case 'audio':
    case 'voice':
      return { type: 'audio', audio: mediaObject(media) }
    case 'document': {
      const extra: Record<string, unknown> = {}
      if (content.filename) extra.filename = content.filename
      if (content.caption) extra.caption = content.caption
      return { type: 'document', document: mediaObject(media, extra) }
    }
    case 'sticker':
      return { type: 'sticker', sticker: mediaObject(media) }

    case 'location': {
      const location: Record<string, unknown> = { latitude: content.lat, longitude: content.lng }
      if (content.name) location.name = content.name
      if (content.address) location.address = content.address
      return { type: 'location', location }
    }

    case 'contact':
      return {
        type: 'contacts',
        contacts: [{
          name: { formatted_name: content.displayName ?? content.phone },
          phones: [{ phone: content.phone, type: 'CELL' }],
        }],
      }

    case 'reaction':
      return { type: 'reaction', reaction: { message_id: content.target.id, emoji: content.emoji } }

    case 'buttons': {
      const buttons = content.buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title.slice(0, 20) },
      }))
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.text },
          action: { buttons },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
        },
      }
    }

    case 'list': {
      const sections = content.sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title.slice(0, 24),
          ...(r.description ? { description: r.description } : {}),
        })),
      }))
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: content.text },
          action: { button: content.buttonText.slice(0, 20), sections },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
        },
      }
    }

    case 'card':
      return { type: 'text', text: { body: [content.title, content.body].filter(Boolean).join('\n') } }

    case 'template':
      return {
        type: 'template',
        template: { name: content.name, language: { code: content.language }, components: content.components ?? [] },
      }

    case 'native':
      return content.payload as Record<string, unknown>

    case 'poll':
      throw new UnsupportedContentError('poll', 'WhatsApp Cloud API no soporta mensajes de encuesta (Graph 131051). Usa botones (kind buttons) o WhatsApp Flows.')
  }
}
