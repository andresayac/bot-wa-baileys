/**
 * `OutboundContent` → Twilio Messages API form params (without To/From).
 *
 *  - Media is referenced by PUBLIC URL (`MediaUrl`): Twilio downloads it.
 *  - `buttons` / `list` degrade to a numbered text menu (interactive messages
 *    on Twilio need pre-approved Content templates → use `template`).
 *  - `template` → `ContentSid` (`name`) + `ContentVariables` (`components`).
 *  - `location` → `PersistentAction: geo:lat,lng|label` (WhatsApp).
 *  - `native` → payload params merged verbatim (e.g. `{ ContentSid, ShortenUrls }`).
 */

import { UnsupportedContentError, type MediaSource, type OutboundContent } from '@botmesh/core'
import { listRows, numberedText } from './http.js'

export type TwilioOutboundParams = Record<string, string | string[]>

/** Public URL of a media source, or an `UnsupportedContentError`. */
export function mediaUrlOf(source: MediaSource, kind: OutboundContent['kind']): string {
  if (typeof source === 'string' && /^https?:\/\//i.test(source)) return source
  if (typeof source === 'object' && source !== null && !Buffer.isBuffer(source)) {
    if ('url' in source && typeof source.url === 'string') return source.url
    if ('native' in source && typeof source.native === 'string' && /^https?:\/\//i.test(source.native)) return source.native
  }
  throw new UnsupportedContentError(
    kind,
    `Twilio fetches media from a public URL — got a non-URL MediaSource for '${kind}'. Host the file and pass its URL.`,
  )
}

export function toOutbound(content: OutboundContent): TwilioOutboundParams {
  switch (content.kind) {
    case 'text':
      return { Body: content.text }
    case 'image':
    case 'video':
      return { MediaUrl: [mediaUrlOf(content.media, content.kind)], ...(content.caption ? { Body: content.caption } : {}) }
    case 'audio':
    case 'voice':
    case 'sticker':
      return { MediaUrl: [mediaUrlOf(content.media, content.kind)] }
    case 'document':
      return { MediaUrl: [mediaUrlOf(content.media, content.kind)], ...(content.caption ? { Body: content.caption } : {}) }
    case 'location': {
      const label = [content.name, content.address].filter(Boolean).join(', ')
      return {
        Body: label || `${content.lat},${content.lng}`,
        PersistentAction: [`geo:${content.lat},${content.lng}${label ? `|${label}` : ''}`],
      }
    }
    case 'buttons':
      return { Body: numberedText(content.text, content.buttons, content.footer) }
    case 'list':
      return { Body: numberedText(content.text, listRows(content.sections), content.footer) }
    case 'template': {
      const vars = content.components
      return {
        ContentSid: content.name,
        ...(vars !== undefined ? { ContentVariables: typeof vars === 'string' ? vars : JSON.stringify(vars) } : {}),
      }
    }
    case 'native': {
      if (content.provider !== 'twilio') {
        throw new UnsupportedContentError('native', `native content for '${content.provider}' cannot be sent through Twilio`)
      }
      const payload = content.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new UnsupportedContentError('native', 'Twilio native payload must be an object of Messages API params')
      }
      const out: TwilioOutboundParams = {}
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (value === undefined || value === null) continue
        out[key] = Array.isArray(value) ? value.map((v) => String(v)) : typeof value === 'object' ? JSON.stringify(value) : String(value)
      }
      return out
    }
    default:
      throw new UnsupportedContentError(content.kind, `Twilio cannot send '${content.kind}' content`)
  }
}
