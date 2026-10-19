/**
 * Outbound media resolution shared by the REST mappers: a public URL is handed
 * to the gateway as-is (the gateway downloads it); everything else is read into
 * memory and sent inline as base64.
 */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { UnsupportedContentError, type MediaSource, type OutboundContent } from '@bot-wa/core'

export type ResolvedMedia =
  | { url: string; filename?: string; mimetype?: string }
  | { base64: string; filename?: string; mimetype: string }

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.3gp': 'video/3gpp', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const KIND_MIME: Partial<Record<OutboundContent['kind'], string>> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  voice: 'audio/ogg; codecs=opus',
  sticker: 'image/webp',
  document: 'application/octet-stream',
}

/** Best-effort MIME type: explicit → file extension → per-kind default. */
export function guessMimetype(kind: OutboundContent['kind'], filename?: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filename ? extname(filename).toLowerCase() : ''
  return EXT_MIME[ext] ?? KIND_MIME[kind] ?? 'application/octet-stream'
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

/**
 * Resolve a {@link MediaSource}. `{ native: string }` is passed through as a
 * URL-or-base64 value the gateway understands natively.
 */
export async function resolveMedia(
  kind: OutboundContent['kind'],
  source: MediaSource,
  opts: { filename?: string; mimetype?: string } = {},
): Promise<ResolvedMedia> {
  const inline = (buffer: Buffer, filename?: string): ResolvedMedia => ({
    base64: buffer.toString('base64'),
    filename,
    mimetype: guessMimetype(kind, filename, opts.mimetype),
  })
  if (typeof source === 'string') {
    if (/^https?:\/\//i.test(source)) return { url: source, filename: opts.filename, mimetype: opts.mimetype }
    const filename = opts.filename ?? basename(source)
    return inline(await readFile(source), filename)
  }
  if (Buffer.isBuffer(source)) return inline(source, opts.filename)
  if ('url' in source) return { url: source.url, filename: opts.filename, mimetype: opts.mimetype }
  if ('buffer' in source) return inline(source.buffer, opts.filename)
  if ('path' in source) return inline(await readFile(source.path), opts.filename ?? basename(source.path))
  if ('stream' in source) return inline(await streamToBuffer(source.stream), opts.filename)
  if ('native' in source && typeof source.native === 'string') {
    return { url: source.native, filename: opts.filename, mimetype: opts.mimetype }
  }
  throw new UnsupportedContentError(kind, 'Unsupported MediaSource: expected a URL, Buffer, path, stream or { native: string }')
}

/** `data:<mime>;base64,<payload>` (WPPConnect style) or the plain URL. */
export function toDataUri(media: ResolvedMedia): string {
  return 'url' in media ? media.url : `data:${media.mimetype};base64,${media.base64}`
}
