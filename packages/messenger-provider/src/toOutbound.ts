/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to a Messenger
 * Send API `message` object (the value under `message` in the
 * `POST /{page-id}/messages` request; sender actions are sent separately).
 *
 * Media is resolved to a public URL by the provider BEFORE this is called —
 * the Send API takes `{ attachment: { type, payload: { url, is_reusable } } }`
 * and this provider does not implement chunked upload. Polls, reactions,
 * location, contact and Cloud-API-style templates have no Send API endpoint and
 * throw {@link UnsupportedContentError}.
 */

import { UnsupportedContentError, type OutboundContent } from '@bot-wa/core'

function attachmentMessage(type: 'image' | 'video' | 'audio' | 'file', url: string | undefined): Record<string, unknown> {
  if (!url) {
    throw new UnsupportedContentError('image', 'Messenger needs a public URL (or upload the media first).')
  }
  return { attachment: { type, payload: { url, is_reusable: true } } }
}

/**
 * @returns the `message` payload ready to wrap in
 *   `{ recipient:{id}, messaging_type:'RESPONSE', message }`.
 */
export function toOutbound(content: OutboundContent, mediaUrl?: string): Record<string, unknown> {
  switch (content.kind) {
    case 'text':
      return { text: content.text }

    case 'image':
      return attachmentMessage('image', mediaUrl)
    case 'video':
      return attachmentMessage('video', mediaUrl)
    case 'audio':
    case 'voice':
      return attachmentMessage('audio', mediaUrl)
    case 'document':
      return attachmentMessage('file', mediaUrl)

    case 'buttons': {
      const buttons = content.buttons.slice(0, 3).map((b) => ({
        type: 'postback',
        title: b.title.slice(0, 20),
        payload: b.id,
      }))
      return {
        attachment: {
          type: 'template',
          payload: { template_type: 'button', text: content.text, buttons },
        },
      }
    }

    case 'list': {
      // Generic template: one element per row (max 10), each with a postback
      // button carrying the row id.
      const rows = content.sections.flatMap((s) => s.rows).slice(0, 10)
      const elements = rows.length
        ? rows.map((r) => ({
            title: r.title,
            ...(r.description ? { subtitle: r.description } : {}),
            buttons: [{ type: 'postback', title: r.title.slice(0, 20), payload: r.id }],
          }))
        : [{ title: content.text }]
      return {
        attachment: {
          type: 'template',
          payload: { template_type: 'generic', elements },
        },
      }
    }

    case 'card':
      return { text: [content.title, content.body].filter(Boolean).join('\n') }

    case 'native':
      return content.payload as Record<string, unknown>

    case 'sticker':
      throw new UnsupportedContentError('sticker', 'Messenger has no Send API for stickers — send the image instead (kind image).')
    case 'poll':
      throw new UnsupportedContentError('poll', 'Messenger has no Send API for polls — use buttons (kind buttons) or a generic template list.')
    case 'reaction':
      throw new UnsupportedContentError('reaction', 'Sending reactions has no public Send API endpoint on Messenger (they arrive inbound only).')
    case 'location':
      throw new UnsupportedContentError('location', 'Sending locations has no Send API endpoint on Messenger — send a map link as text.')
    case 'contact':
      throw new UnsupportedContentError('contact', 'Sending contacts has no Send API endpoint on Messenger — send the contact as text.')
    case 'template':
      throw new UnsupportedContentError('template', 'Messenger has no Cloud-API-style template messages — use text, buttons or a generic template (kind list).')
  }
}
