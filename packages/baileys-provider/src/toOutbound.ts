/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to a Baileys
 * `AnyMessageContent`. WhatsApp has no reliable native buttons/lists, so those
 * degrade to numbered text; Cloud-API-only kinds (`template`) and `native`
 * throw {@link UnsupportedContentError}.
 */

import type { AnyMessageContent, WAMessage } from '@whiskeysockets/baileys'
import { UnsupportedContentError, type OutboundContent } from '@botmesh/core'
import { toMediaUpload, resolveRemoteMedia, makeSticker, transcodeToOpus, type RemoteMediaConfig } from './MediaProcessor.js'

function vcard(phone: string, displayName?: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return (
    'BEGIN:VCARD\nVERSION:3.0\n' +
    `FN:${displayName ?? phone}\n` +
    `TEL;type=CELL;type=VOICE;waid=${digits}:${phone}\n` +
    'END:VCARD'
  )
}

function numberedButtons(text: string, rows: Array<{ title: string }>, footer?: string): string {
  const menu = rows.map((r, i) => `${i + 1}) ${r.title}`).join('\n')
  return [text, '', menu, footer ? `\n${footer}` : ''].filter(Boolean).join('\n')
}

export async function toOutbound(content: OutboundContent, remoteMedia: RemoteMediaConfig = {}): Promise<AnyMessageContent> {
  const upload = (media: Parameters<typeof toMediaUpload>[0]) => resolveRemoteMedia(toMediaUpload(media), content.kind, remoteMedia)
  switch (content.kind) {
    case 'text':
      return { text: content.text }
    case 'image':
      return { image: await upload(content.media), caption: content.caption, viewOnce: content.viewOnce } as AnyMessageContent
    case 'video':
      return { video: await upload(content.media), caption: content.caption, gifPlayback: content.gifPlayback, ptv: content.ptv, viewOnce: content.viewOnce } as AnyMessageContent
    case 'audio':
      return { audio: await upload(content.media), mimetype: 'audio/ogg; codecs=opus', ptt: false } as AnyMessageContent
    case 'voice': {
      const opus = await transcodeToOpus(content.media)
      return { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true } as AnyMessageContent
    }
    case 'document':
      return { document: await upload(content.media), fileName: content.filename, caption: content.caption, mimetype: content.mimetype } as AnyMessageContent
    case 'sticker': {
      const sticker = await makeSticker(content.media, { pack: content.pack, author: content.author })
      return { sticker } as AnyMessageContent
    }
    case 'location':
      return { location: { degreesLatitude: content.lat, degreesLongitude: content.lng, name: content.name, address: content.address } }
    case 'contact':
      return { contacts: { displayName: content.displayName ?? content.phone, contacts: [{ vcard: vcard(content.phone, content.displayName) }] } }
    case 'form':
      throw new UnsupportedContentError('form', 'This transport has no native forms — flow().form() asks field by field instead (capabilities.forms is not "native").')
    case 'poll':
      return { poll: { name: content.question, values: content.options, selectableCount: content.multiSelect ? content.options.length : 1 } }
    case 'reaction':
      return { react: { text: content.emoji, key: (content.target.native as WAMessage).key } }
    case 'buttons':
      return { text: numberedButtons(content.text, content.buttons.map((b) => ({ title: b.title })), content.footer) }
    case 'list':
      return { text: numberedButtons(content.text, content.sections.flatMap((s) => s.rows), content.footer) }
    case 'card':
      return { text: [content.title, content.body].filter(Boolean).join('\n') }
    case 'template':
      throw new UnsupportedContentError('template', 'WhatsApp templates require the Cloud API transport, not Baileys.')
    case 'native':
      throw new UnsupportedContentError('native', 'Baileys has no native-component surface.')
  }
}
