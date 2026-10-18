/**
 * OutboundContent -> email body + attachments. Email has no buttons, lists,
 * polls or reactions: buttons/lists/cards degrade to numbered text (like
 * Baileys), poll/reaction/template are rejected with `UnsupportedContentError`,
 * and `native` with `provider: 'email'` passes subject, text, html, cc, bcc,
 * extra headers and in-memory attachments through.
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
  overrides: Partial<Pick<SmtpMailOptions, 'subject' | 'cc' | 'bcc' | 'html' | 'text' | 'headers'>>
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

const isAddressField = (v: unknown): v is string | string[] =>
  typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))

/**
 * Validate `native` attachments: only in-memory content is accepted. nodemailer
 * would otherwise read `path` from disk or fetch `href` itself, bypassing
 * `secureFetch` (SSRF guard) and `maxAttachmentBytes`.
 */
function nativeAttachments(value: unknown): SmtpAttachment[] {
  if (!Array.isArray(value)) throw new UnsupportedContentError('native', 'native email `attachments` must be an array')
  return value.map((a: unknown) => {
    const bad = (why: string) => new UnsupportedContentError('native', `native email attachment ${why}; send media content kinds for files or URLs`)
    if (typeof a !== 'object' || a === null) throw bad('must be an object')
    const att = a as Record<string, unknown>
    const extra = Object.keys(att).filter((k) => !['filename', 'content', 'contentType', 'cid'].includes(k))
    if (extra.length) throw bad(`has unsupported fields (${extra.join(', ')})`)
    if (!(att.content instanceof Uint8Array)) throw bad('needs `content` as a Buffer or Uint8Array')
    for (const k of ['filename', 'contentType', 'cid'] as const) {
      if (att[k] !== undefined && typeof att[k] !== 'string') throw bad(`\`${k}\` must be a string`)
    }
    const out: SmtpAttachment = { content: Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content) }
    if (typeof att.filename === 'string') out.filename = att.filename
    if (typeof att.contentType === 'string') out.contentType = att.contentType
    if (typeof att.cid === 'string') out.cid = att.cid
    return out
  })
}

/** Headers the provider owns: threading, identity and loop protection. */
const PROTECTED_HEADERS = new Set([
  'auto-submitted', 'x-auto-response-suppress', 'message-id', 'in-reply-to', 'references',
  'from', 'to', 'cc', 'bcc', 'sender', 'reply-to', 'subject', 'content-type', 'content-transfer-encoding', 'mime-version',
])

function nativeHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnsupportedContentError('native', 'native email `headers` must be an object of strings')
  }
  const out: Record<string, string> = {}
  for (const [name, v] of Object.entries(value)) {
    if (typeof v !== 'string' || /[\r\n]/.test(v) || !/^[!-9;-~]+$/.test(name)) {
      throw new UnsupportedContentError('native', `native email header "${name}" is not a valid single-line string`)
    }
    if (!PROTECTED_HEADERS.has(name.toLowerCase())) out[name] = v
  }
  return out
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
      const p = (typeof content.payload === 'object' && content.payload !== null ? content.payload : {}) as Record<string, unknown>
      const overrides: ComposedMail['overrides'] = {}
      if (typeof p.subject === 'string') overrides.subject = p.subject
      if (typeof p.text === 'string') overrides.text = p.text
      if (typeof p.html === 'string') overrides.html = p.html
      if (isAddressField(p.cc)) overrides.cc = p.cc
      if (isAddressField(p.bcc)) overrides.bcc = p.bcc
      if (p.headers !== undefined) overrides.headers = nativeHeaders(p.headers)
      return {
        text: overrides.text ?? '',
        html: overrides.html,
        attachments: p.attachments === undefined ? [] : nativeAttachments(p.attachments),
        overrides,
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
