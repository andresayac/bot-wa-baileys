/**
 * `OutboundContent` → `POST /conversations/messages` body fields (without
 * `type`/`contactId`, which the provider adds).
 *
 *  - Media is passed as public attachment URLs (`attachments: [url]`); the
 *    caption becomes `message`.
 *  - `buttons` / `list` degrade to a numbered text menu (the Conversations API
 *    has no interactive widgets).
 *  - `template` → `templateId` (`name`).
 *  - `native` → payload fields merged verbatim (e.g. `{ html, subject }`).
 */

import { UnsupportedContentError, type MediaSource, type OutboundContent } from '@bot-wa/core'
import { listRows, numberedText } from './http.js'

export type GhlOutboundFields = Record<string, unknown>

export function mediaUrlOf(source: MediaSource, kind: OutboundContent['kind']): string {
  if (typeof source === 'string' && /^https?:\/\//i.test(source)) return source
  if (typeof source === 'object' && source !== null && !Buffer.isBuffer(source)) {
    if ('url' in source && typeof source.url === 'string') return source.url
    if ('native' in source && typeof source.native === 'string' && /^https?:\/\//i.test(source.native)) return source.native
  }
  throw new UnsupportedContentError(
    kind,
    `HighLevel attaches media by public URL — got a non-URL MediaSource for '${kind}'. Host the file (e.g. HighLevel Media Library) and pass its URL.`,
  )
}

export function toOutbound(content: OutboundContent): GhlOutboundFields {
  switch (content.kind) {
    case 'text':
      return { message: content.text }
    case 'image':
    case 'video':
    case 'document':
      return { attachments: [mediaUrlOf(content.media, content.kind)], ...(content.caption ? { message: content.caption } : {}) }
    case 'audio':
    case 'voice':
      return { attachments: [mediaUrlOf(content.media, content.kind)] }
    case 'buttons':
      return { message: numberedText(content.text, content.buttons, content.footer) }
    case 'list':
      return { message: numberedText(content.text, listRows(content.sections), content.footer) }
    case 'template':
      return { templateId: content.name }
    case 'native': {
      if (content.provider !== 'gohighlevel') {
        throw new UnsupportedContentError('native', `native content for '${content.provider}' cannot be sent through HighLevel`)
      }
      const payload = content.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new UnsupportedContentError('native', 'HighLevel native payload must be an object of /conversations/messages fields')
      }
      return { ...(payload as Record<string, unknown>) }
    }
    default:
      throw new UnsupportedContentError(content.kind, `HighLevel cannot send '${content.kind}' content`)
  }
}
