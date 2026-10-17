/**
 * OutboundContent -> email body + attachments. Email has no buttons, lists,
 * polls or reactions: buttons/lists/cards degrade to numbered text (like
 * Baileys), poll/reaction/template are rejected with `UnsupportedContentError`,
 * and `native` with `provider: 'email'` passes mail fields through.
 */

import { UnsupportedContentError, type MediaSource, type OutboundContent } from '@bot-wa/core'
import type { SmtpAttachment, SmtpMailOptions } from './types.js'

export interface ResolvedMedia {
  content: Buffer
  filename?: string
  contentType?: string
}

export type MediaResolver = (source: MediaSource, kind: OutboundContent['kind']) => Promise<ResolvedMedia>

export interface ComposedMail {
  text: string
  html?: string
  attachments: SmtpAttachment[]
  /** Fields set by a `native` payload (subject, cc, bcc, headers, ...). */
  overrides: Partial<Pick<SmtpMailOptions, 'subject' | 'cc' | 'bcc' | 'html' | 'text' | 'headers' | 'attachments'>>
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  'text/plain': 'txt', 'application/zip': 'zip',
}

/** Best-effort content type from magic bytes. */
export function sniffMime(buf: Buffer): string | undefined {
  const hex = buf.subarray(0, 12).toString('hex')
  if (hex.startsWith('89504e47')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (hex.startsWith('47494638')) return 'image/gif'
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (hex.startsWith('25504446')) return 'application/pdf'
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4'
  if (hex.startsWith('4f676753')) return 'audio/ogg'
  if (hex.startsWith('494433') || hex.startsWith('fffb')) return 'audio/mpeg'
  if (hex.startsWith('504b0304')) return 'application/zip'
  return undefined
}

function numbered(items: string[]): string {
  return items.map((t, i) => `${i + 1}. ${t}`).join('\n')
}

function joinBlocks(blocks: Array<string | undefined>): string {
  return blocks.filter((b): b is string => !!b && b.length > 0).join('\n\n')
}

async function attachment(
  resolve: MediaResolver,
  kind: OutboundContent['kind'],
  source: MediaSource,
  filename?: string,
  mimetype?: string,
): Promise<SmtpAttachment> {
  const media = await resolve(source, kind)
  const contentType = mimetype ?? media.contentType ?? sniffMime(media.content)
  const ext = contentType ? EXT_BY_MIME[contentType.split(';')[0]!.trim()] : undefined
  const name = filename ?? media.filename ?? (ext ? `${kind}.${ext}` : kind)
  const out: SmtpAttachment = { filename: name, content: media.content }
  if (contentType) out.contentType = contentType
  return out
}

/** Build the text/html body and attachments for one OutboundContent. */
export async function composeContent(content: OutboundContent, resolve: MediaResolver): Promise<ComposedMail> {
  switch (content.kind) {
    case 'text':
      return { text: content.text, attachments: [], overrides: {} }
    case 'image':
    case 'video':
      return { text: content.caption ?? '', attachments: [await attachment(resolve, content.kind, content.media)], overrides: {} }
    case 'audio':
    case 'voice':
      return { text: '', attachments: [await attachment(resolve, content.kind, content.media)], overrides: {} }
    case 'sticker':
      return { text: '', attachments: [await attachment(resolve, content.kind, content.media)], overrides: {} }
    case 'document':
      return {
        text: content.caption ?? '',
        attachments: [await attachment(resolve, content.kind, content.media, content.filename, content.mimetype)],
        overrides: {},
      }
    case 'location': {
      const lines = [content.name, content.address, `https://www.google.com/maps?q=${content.lat},${content.lng}`]
      return { text: lines.filter(Boolean).join('\n'), attachments: [], overrides: {} }
    }
    case 'contact':
      return { text: content.displayName ? `${content.displayName}: ${content.phone}` : content.phone, attachments: [], overrides: {} }
    case 'buttons':
      return {
        text: joinBlocks([content.text, numbered(content.buttons.map((b) => (b.url ? `${b.title}: ${b.url}` : b.title))), content.footer]),
        attachments: [],
        overrides: {},
      }
    case 'list': {
      let n = 0
      const sections = content.sections.map((s) => {
        const rows = s.rows.map((r) => `${++n}. ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n')
        return s.title ? `${s.title}\n${rows}` : rows
      })
      return { text: joinBlocks([content.text, ...sections, content.footer]), attachments: [], overrides: {} }
    }
    case 'card': {
      const buttons = content.buttons?.length
        ? numbered(content.buttons.map((b) => (b.url ? `${b.title}: ${b.url}` : b.title)))
        : undefined
      return { text: joinBlocks([content.title, content.body, content.imageUrl, buttons]), attachments: [], overrides: {} }
    }
    case 'native': {
      if (content.provider !== 'email') {
        throw new UnsupportedContentError('native', `EmailProvider cannot send native content for provider "${content.provider}"`)
      }
      const p = (typeof content.payload === 'object' && content.payload !== null ? content.payload : {}) as ComposedMail['overrides']
      return {
        text: typeof p.text === 'string' ? p.text : '',
        html: typeof p.html === 'string' ? p.html : undefined,
        attachments: Array.isArray(p.attachments) ? p.attachments : [],
        overrides: p,
      }
    }
    case 'poll':
    case 'reaction':
    case 'template':
      throw new UnsupportedContentError(content.kind, `EmailProvider cannot send "${content.kind}" content`)
    default: {
      const kind = (content as { kind: OutboundContent['kind'] }).kind
      throw new UnsupportedContentError(kind)
    }
  }
}
