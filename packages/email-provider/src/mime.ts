/**
 * A small, dependency-free RFC 5322 / MIME parser — enough for a bot: headers
 * (folded, RFC 2047 / RFC 6532), multipart trees, base64 / quoted-printable,
 * charsets, RFC 2231 parameters, text/html bodies and attachments.
 *
 * It is deliberately lenient: malformed input degrades (unknown charset ->
 * UTF-8/latin1, missing boundary -> single part) instead of throwing, because a
 * provider must never crash its ingest loop on one weird email.
 */

import { parseAddressList, type EmailAddress } from './address.js'
import { decodeCharset, decodeEncodedWords, decodeQuotedPrintable } from './mime-words.js'

export { decodeEncodedWords } from './mime-words.js'

/** Lower-cased header name -> raw (unfolded, NOT encoded-word-decoded) values, in order. */
export type HeaderMap = Map<string, string[]>

export interface MimePart {
  headers: HeaderMap
  /** Lower-cased `type/subtype`; defaults to `text/plain`. */
  contentType: string
  contentTypeParams: Record<string, string>
  disposition?: 'inline' | 'attachment' | string
  dispositionParams: Record<string, string>
  /** Transfer-decoded body bytes (empty for multiparts). */
  body: Buffer
  children: MimePart[]
}

export interface ParsedAttachment {
  filename?: string
  mimetype: string
  size: number
  content: Buffer
  /** `true` for inline parts (e.g. a signature logo referenced by `cid:`). */
  inline: boolean
  contentId?: string
}

export interface ParsedEmail {
  headers: HeaderMap
  /** First value of a header (case-insensitive), RFC 2047-decoded and trimmed. */
  header(name: string): string | undefined
  /** Message-ID without angle brackets. */
  messageId?: string
  inReplyTo?: string
  references: string[]
  subject: string
  from?: EmailAddress
  replyTo: EmailAddress[]
  to: EmailAddress[]
  cc: EmailAddress[]
  date?: Date
  text?: string
  html?: string
  attachments: ParsedAttachment[]
  root: MimePart
}

const MAX_DEPTH = 20

/* ---------------------------------------------------------------- headers */

function splitHeaderBody(buf: Buffer): { head: Buffer; body: Buffer } {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf === -1 && lf === -1) {
    // A message made only of headers (or only a body when it starts with a blank line).
    if (buf.length && (buf[0] === 0x0a || (buf[0] === 0x0d && buf[1] === 0x0a))) {
      return { head: Buffer.alloc(0), body: buf.subarray(buf[0] === 0x0a ? 1 : 2) }
    }
    return { head: buf, body: Buffer.alloc(0) }
  }
  if (buf[0] === 0x0a) return { head: Buffer.alloc(0), body: buf.subarray(1) }
  if (buf[0] === 0x0d && buf[1] === 0x0a) return { head: Buffer.alloc(0), body: buf.subarray(2) }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { head: buf.subarray(0, crlf), body: buf.subarray(crlf + 4) }
  return { head: buf.subarray(0, lf), body: buf.subarray(lf + 2) }
}

/** Parse a header block into a case-insensitive multimap (values unfolded, raw). */
export function parseHeaders(head: Buffer | string): HeaderMap {
  const text = typeof head === 'string' ? head : decodeCharset(head, 'utf-8')
  const map: HeaderMap = new Map()
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!name || /\s/.test(name)) continue
    const value = line.slice(colon + 1).trim()
    const list = map.get(name)
    if (list) list.push(value)
    else map.set(name, [value])
  }
  return map
}

function splitParams(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch === '\\' && quoted && i + 1 < value.length) { cur += ch + value[++i]; continue }
    if (ch === '"') quoted = !quoted
    if (ch === ';' && !quoted) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

function percentDecode(value: string, charset: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      for (const b of Buffer.from(value[i]!, 'utf8')) bytes.push(b)
    }
  }
  return decodeCharset(Buffer.from(bytes), charset || 'utf-8')
}

/**
 * Parse a structured header value with parameters (`Content-Type`,
 * `Content-Disposition`), including RFC 2231 extended values (`name*=utf-8''..`)
 * and continuations (`name*0=`, `name*1*=`). Param names are lower-cased.
 */
export function parseHeaderParams(raw: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = splitParams(raw)
  const params: Record<string, string> = {}
  const continuations = new Map<string, Array<{ index: number; value: string; extended: boolean }>>()
  for (const piece of rest) {
    const eq = piece.indexOf('=')
    if (eq === -1) continue
    let key = piece.slice(0, eq).trim().toLowerCase()
    let val = piece.slice(eq + 1).trim()
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, '$1')
    const cont = /^(.+?)\*(\d+)(\*?)$/.exec(key)
    if (cont) {
      const list = continuations.get(cont[1]!) ?? []
      list.push({ index: Number(cont[2]), value: val, extended: cont[3] === '*' })
      continuations.set(cont[1]!, list)
      continue
    }
    if (key.endsWith('*')) {
      key = key.slice(0, -1)
      const m = /^([^']*)'[^']*'(.*)$/.exec(val)
      params[key] = m ? percentDecode(m[2]!, m[1]!) : percentDecode(val, 'utf-8')
      continue
    }
    params[key] = decodeEncodedWords(val)
  }
  for (const [key, pieces] of continuations) {
    pieces.sort((a, b) => a.index - b.index)
    let charset = 'utf-8'
    let out = ''
    for (const p of pieces) {
      let v = p.value
      if (p.extended) {
        if (p.index === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v)
          if (m) { charset = m[1] || 'utf-8'; v = m[2]! }
        }
        out += percentDecode(v, charset)
      } else {
        out += v
      }
    }
    params[key] = out
  }
  return { value: (first ?? '').trim().toLowerCase(), params }
}

/* ---------------------------------------------------------------- bodies */

function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase()
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const s = body.toString('latin1')
  const delim = `--${boundary}`
  const parts: Buffer[] = []
  let start = -1
  let pos = 0
  while (pos <= s.length) {
    const idx = s.indexOf(delim, pos)
    if (idx === -1) break
    const atLineStart = idx === 0 || s[idx - 1] === '\n'
    if (!atLineStart) { pos = idx + delim.length; continue }
    if (start !== -1) {
      let end = idx
      if (s[end - 1] === '\n') end--
      if (s[end - 1] === '\r') end--
      parts.push(Buffer.from(s.slice(start, Math.max(start, end)), 'latin1'))
    }
    const after = idx + delim.length
    if (s.startsWith('--', after)) { start = -1; break }
    const eol = s.indexOf('\n', after)
    if (eol === -1) { start = -1; break }
    start = eol + 1
    pos = start
  }
  if (start !== -1 && start < s.length) parts.push(Buffer.from(s.slice(start), 'latin1')) // unterminated last part
  return parts
}

function firstHeader(headers: HeaderMap, name: string): string | undefined {
  return headers.get(name)?.[0]
}

/** Parse one MIME entity (recursively). */
export function parsePart(buf: Buffer, depth = 0, defaultType = 'text/plain'): MimePart {
  const { head, body } = splitHeaderBody(buf)
  const headers = parseHeaders(head)
  const ct = parseHeaderParams(firstHeader(headers, 'content-type') ?? defaultType)
  const contentType = ct.value.includes('/') ? ct.value : defaultType
  const cd = firstHeader(headers, 'content-disposition')
  const disp = cd ? parseHeaderParams(cd) : undefined
  const part: MimePart = {
    headers,
    contentType,
    contentTypeParams: ct.params,
    disposition: disp?.value || undefined,
    dispositionParams: disp?.params ?? {},
    body: Buffer.alloc(0),
    children: [],
  }
  const boundary = ct.params.boundary
  if (contentType.startsWith('multipart/') && boundary && depth < MAX_DEPTH) {
    const childDefault = contentType === 'multipart/digest' ? 'message/rfc822' : 'text/plain'
    part.children = splitMultipart(body, boundary).map((b) => parsePart(b, depth + 1, childDefault))
    return part
  }
  part.body = decodeTransfer(body, firstHeader(headers, 'content-transfer-encoding'))
  return part
}

/** Decoded text of a leaf text part. */
export function partText(part: MimePart): string {
  return decodeCharset(part.body, part.contentTypeParams.charset)
}

/* ---------------------------------------------------------------- extraction */

function msgIds(value: string | undefined): string[] {
  if (!value) return []
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!)
  if (bracketed.length) return bracketed
  return value.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.includes('@'))
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/(\r?\n)+$/, '')
}

function filenameOf(part: MimePart): string | undefined {
  const name = part.dispositionParams.filename ?? part.contentTypeParams.name
  return name ? decodeEncodedWords(name) : undefined
}

function isAttachmentLike(part: MimePart): boolean {
  if (part.disposition === 'attachment') return true
  if (!part.contentType.startsWith('text/')) return true
  return filenameOf(part) !== undefined && part.disposition !== 'inline'
}

interface Collected { text: string[]; html: string[]; attachments: ParsedAttachment[] }

function collect(part: MimePart, out: Collected): void {
  if (part.contentType.startsWith('multipart/')) {
    if (part.contentType === 'multipart/alternative') {
      // Pick the best plain and the best html among the alternatives (last wins per RFC 2046).
      const before = { text: out.text.length, html: out.html.length }
      for (const child of part.children) {
        const sub: Collected = { text: [], html: [], attachments: [] }
        collect(child, sub)
        if (sub.text.length) { out.text.splice(before.text); out.text.push(...sub.text) }
        if (sub.html.length) { out.html.splice(before.html); out.html.push(...sub.html) }
        out.attachments.push(...sub.attachments)
      }
      return
    }
    for (const child of part.children) collect(child, out)
    return
  }
  if (part.contentType === 'message/rfc822') {
    const inner = parsePart(part.body)
    const subject = decodeEncodedWords(firstHeader(inner.headers, 'subject') ?? '').trim()
    out.attachments.push({
      filename: filenameOf(part) ?? `${(subject || 'message').replace(/[\\/:*?"<>|]+/g, '_')}.eml`,
      mimetype: 'message/rfc822',
      size: part.body.length,
      content: part.body,
      inline: false,
    })
    return
  }
  if (!isAttachmentLike(part)) {
    if (part.contentType === 'text/html') {
      const html = partText(part)
      if (html.trim()) out.html.push(html)
    }
    else if (part.contentType === 'text/plain' || part.contentType === 'text/enriched' || part.contentType === 'text/markdown') {
      const text = stripTrailingNewlines(partText(part))
      if (text.trim()) out.text.push(text)
    }
    return
  }
  const cid = firstHeader(part.headers, 'content-id')
  out.attachments.push({
    filename: filenameOf(part),
    mimetype: part.contentType,
    size: part.body.length,
    content: part.body,
    inline: part.disposition === 'inline',
    contentId: cid ? cid.replace(/^<|>$/g, '') : undefined,
  })
}

/** Parse a full RFC 5322 message (raw bytes as delivered by IMAP / an inbound webhook). */
export function parseEmail(source: Buffer | Uint8Array | string): ParsedEmail {
  const buf = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source)
  const root = parsePart(buf)
  const headers = root.headers
  const header = (name: string): string | undefined => {
    const v = firstHeader(headers, name.toLowerCase())
    return v === undefined ? undefined : decodeEncodedWords(v).trim()
  }
  const collected: Collected = { text: [], html: [], attachments: [] }
  collect(root, collected)
  const dateRaw = firstHeader(headers, 'date')
  const date = dateRaw ? new Date(dateRaw) : undefined
  const text = collected.text.length ? collected.text.join('\n') : undefined
  const html = collected.html.length ? collected.html.join('\n') : undefined
  return {
    headers,
    header,
    messageId: msgIds(firstHeader(headers, 'message-id'))[0],
    inReplyTo: msgIds(firstHeader(headers, 'in-reply-to'))[0],
    references: msgIds(firstHeader(headers, 'references')),
    subject: decodeEncodedWords(firstHeader(headers, 'subject') ?? '').trim(),
    from: parseAddressList(firstHeader(headers, 'from'))[0],
    replyTo: parseAddressList(firstHeader(headers, 'reply-to')),
    to: (headers.get('to') ?? []).flatMap((v) => parseAddressList(v)),
    cc: (headers.get('cc') ?? []).flatMap((v) => parseAddressList(v)),
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    text,
    html,
    attachments: collected.attachments,
    root,
  }
}
