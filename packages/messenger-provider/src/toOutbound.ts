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

import { UnsupportedContentError, type Button, type OutboundContent } from '@bot-wa/core'

/** Send API limits: button titles 20 chars, template titles/subtitles 80, 3 buttons per template. */
const BUTTON_TITLE = 20
const ELEMENT_TEXT = 80
const MAX_BUTTONS = 3

/** A URL button opens the link (web_url); any other button posts its id back (postback). */
function sendApiButton(b: Pick<Button, 'id' | 'title'> & { url?: string }): Record<string, unknown> {
  const title = b.title.slice(0, BUTTON_TITLE)
  return b.url
    ? { type: 'web_url', title, url: b.url }
    // An empty payload is rejected by the Send API: fall back to the title.
    : { type: 'postback', title, payload: b.id || b.title }
}

function genericTemplate(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return { attachment: { type: 'template', payload: { template_type: 'generic', elements } } }
}

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
      const buttons = content.buttons.slice(0, MAX_BUTTONS).map(sendApiButton)
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
            title: r.title.slice(0, ELEMENT_TEXT),
            ...(r.description ? { subtitle: r.description.slice(0, ELEMENT_TEXT) } : {}),
            buttons: [sendApiButton(r)],
          }))
        : [{ title: content.text.slice(0, ELEMENT_TEXT) }]
      return genericTemplate(elements)
    }

    case 'card': {
      // Without image or buttons a card is just text; otherwise a one-element
      // generic template keeps both instead of dropping them.
      if (!content.imageUrl && !content.buttons?.length) {
        return { text: [content.title, content.body].filter(Boolean).join('\n') }
      }
      return genericTemplate([{
        title: content.title.slice(0, ELEMENT_TEXT),
        ...(content.body ? { subtitle: content.body.slice(0, ELEMENT_TEXT) } : {}),
        ...(content.imageUrl ? { image_url: content.imageUrl } : {}),
        ...(content.buttons?.length ? { buttons: content.buttons.slice(0, MAX_BUTTONS).map(sendApiButton) } : {}),
      }])
    }

    case 'native':
      return content.payload as Record<string, unknown>

    case 'sticker':
      throw new UnsupportedContentError('sticker', 'Messenger has no Send API for stickers — send the image instead (kind image).')
    case 'form':
      throw new UnsupportedContentError('form', 'This transport has no native forms — flow().form() asks field by field instead (capabilities.forms is not "native").')
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
