/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to the Instagram
 * DM Send API `message` object (the value under `message` in the Graph request).
 *
 * The Messenger API for Instagram is URL-based: attachments require a publicly
 * reachable URL. Buffer/path/stream sources are rejected with
 * {@link UnsupportedContentError} (there is no media-upload endpoint for IG DMs).
 * IG supports quick replies but NOT structured buttons, lists, polls, reactions
 * send, location or contact cards — those degrade or throw per capability.
 */

import { UnsupportedContentError, type MediaSource, type OutboundContent } from '@bot-wa/core'

const URL_RE = /^https?:\/\//i

/** IG DM media must be a hosted URL; anything else is rejected with a clear note. */
function mediaUrl(source: MediaSource, kind: OutboundContent['kind']): string {
  if (typeof source === 'string') {
    if (URL_RE.test(source)) return source
    throw new UnsupportedContentError(
      kind,
      `Instagram DM media needs a hosted URL (got a local path "${source}"). Host the file somewhere public and pass its URL (or { url }).`,
    )
  }
  if (Buffer.isBuffer(source)) {
    throw new UnsupportedContentError(kind, 'Instagram DM cannot send raw buffers — provide a hosted URL (https string or { url }).')
  }
  if ('url' in source) return source.url
  if ('native' in source) {
    const n = source.native
    if (typeof n === 'string' && URL_RE.test(n)) return n
    if (n && typeof n === 'object' && typeof (n as { url?: unknown }).url === 'string') return (n as { url: string }).url
    throw new UnsupportedContentError(kind, 'Instagram DM media via native requires a hosted URL string or { url }.')
  }
  throw new UnsupportedContentError(
    kind,
    'Instagram DM Send API is URL-based only (hosted URL / IG media_id); buffer/path/stream sources are unsupported.',
  )
}

function attachment(type: string, url: string): Record<string, unknown> {
  return { attachment: { type, payload: { url, is_reusable: true } } }
}

/** Degrade a list to a numbered-text message (IG has no list messages). */
function listAsText(content: Extract<OutboundContent, { kind: 'list' }>): string {
  const lines: string[] = []
  let n = 1
  for (const section of content.sections) {
    if (section.title) lines.push(section.title)
    for (const row of section.rows) lines.push(`${n++}. ${row.title}`)
  }
  return [content.text, lines.join('\n'), content.footer].filter(Boolean).join('\n\n')
}

/**
 * @returns the Send API `message` payload: `{ text }`,
 *   `{ text, quick_replies }` or `{ attachment: { type, payload: { url } } }`.
 */
export function toOutbound(content: OutboundContent): Record<string, unknown> {
  switch (content.kind) {
    case 'text':
      return { text: content.text }

    case 'image':
      return attachment('image', mediaUrl(content.media, 'image'))
    case 'video':
      return attachment('video', mediaUrl(content.media, 'video'))
    case 'audio':
    case 'voice':
      return attachment('audio', mediaUrl(content.media, 'audio'))
    case 'document':
      return attachment('file', mediaUrl(content.media, 'document'))

    case 'buttons': {
      // IG supports quick replies (tappable chips), NOT structured buttons.
      const quick_replies = content.buttons.slice(0, 13).map((b) => ({
        content_type: 'text',
        title: b.title.slice(0, 20),
        payload: b.id,
      }))
      return { text: content.text, quick_replies }
    }

    case 'list':
      // No list messages in IG DMs — degrade to numbered text.
      return { text: listAsText(content) }

    case 'card':
      return { text: [content.title, content.body].filter(Boolean).join('\n') }

    case 'native':
      return content.payload as Record<string, unknown>

    case 'poll':
      throw new UnsupportedContentError('poll', 'Instagram DM has no poll messages — use quick replies (kind buttons) instead.')
    case 'reaction':
      throw new UnsupportedContentError('reaction', 'Instagram DM reactions cannot be sent through a simple Send API endpoint (inbound reactions are received).')
    case 'location':
      throw new UnsupportedContentError('location', 'Instagram DM has no location messages — send a maps link as text.')
    case 'contact':
      throw new UnsupportedContentError('contact', 'Instagram DM has no contact-card messages — send the contact info as text.')
    case 'sticker':
      throw new UnsupportedContentError('sticker', 'Instagram DM Send API does not accept sticker messages.')
    case 'template':
      throw new UnsupportedContentError('template', 'Instagram DM has no message templates (WhatsApp Cloud API only).')
  }
}
