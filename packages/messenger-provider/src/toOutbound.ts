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

/**
 * Send API limits: button titles 20 chars, generic-template titles/subtitles 80,
 * button-template text 640, 3 buttons per template.
 */
const BUTTON_TITLE = 20
const ELEMENT_TEXT = 80
const BUTTON_TEXT = 640
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

function buttonTemplate(text: string, buttons: Button[]): Record<string, unknown> {
  return {
    attachment: {
      type: 'template',
      payload: { template_type: 'button', text, buttons: buttons.slice(0, MAX_BUTTONS).map(sendApiButton) },
    },
  }
}

type CardContent = Extract<OutboundContent, { kind: 'card' }>

/**
 * A card as one or more Send API messages, never losing text:
 *  - no image and no buttons: one text message;
 *  - title and body fit a generic-template element (80 chars each): one generic
 *    template with image and buttons;
 *  - otherwise the 80-char cut would drop text, so the card is split: the image
 *    (if any) as an attachment, then the full text with the buttons as a button
 *    template (or, past 640 chars, the text alone followed by a button template
 *    titled with the card title).
 */
function cardMessages(content: CardContent): Array<Record<string, unknown>> {
  const text = [content.title, content.body].filter(Boolean).join('\n')
  const buttons = content.buttons ?? []
  if (!content.imageUrl && !buttons.length) return [{ text }]
  const fits = content.title.length <= ELEMENT_TEXT && (content.body ?? '').length <= ELEMENT_TEXT
  if (fits) {
    return [genericTemplate([{
      title: content.title,
      ...(content.body ? { subtitle: content.body } : {}),
      ...(content.imageUrl ? { image_url: content.imageUrl } : {}),
      ...(buttons.length ? { buttons: buttons.slice(0, MAX_BUTTONS).map(sendApiButton) } : {}),
    }])]
  }
  const messages: Array<Record<string, unknown>> = []
  if (content.imageUrl) messages.push(attachmentMessage('image', content.imageUrl))
  if (!buttons.length) messages.push({ text })
  else if (text.length <= BUTTON_TEXT) messages.push(buttonTemplate(text, buttons))
  else messages.push({ text }, buttonTemplate(content.title.slice(0, BUTTON_TEXT), buttons))
  return messages
}

function attachmentMessage(type: 'image' | 'video' | 'audio' | 'file', url: string | undefined): Record<string, unknown> {
  if (!url) {
    throw new UnsupportedContentError('image', 'Messenger needs a public URL (or upload the media first).')
  }
  return { attachment: { type, payload: { url, is_reusable: true } } }
}

/**
 * Map content to the ordered list of Send API `message` payloads that carry it.
 * Every kind is a single message except a `card` whose title or body exceeds the
 * 80-char generic-template limit: that one is sent as image + text/buttons so no
 * text is cut. The provider's `send()` posts them in order.
 */
export function toOutboundMessages(content: OutboundContent, mediaUrl?: string): Array<Record<string, unknown>> {
  return content.kind === 'card' ? cardMessages(content) : [toOutbound(content, mediaUrl)]
}

/**
 * Single-message mapping. For a long `card` it returns only the last message of
 * {@link toOutboundMessages} (text + buttons); use that function to send it whole.
 *
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

    case 'buttons':
      return buttonTemplate(content.text, content.buttons)

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
      // A card that needs several messages (see toOutboundMessages) maps to its
      // last one here: the text with the buttons.
      const messages = cardMessages(content)
      return messages[messages.length - 1]
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
