/**
 * MediaProcessor — convert MediaSource inputs into Baileys' WAMediaUpload.
 *
 * Includes sticker conversion (sharp) and audio PTT transcode (fluent-ffmpeg).
 */

import { readFileSync, existsSync } from 'fs'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

import { PayloadTooLargeError, UnsupportedContentError, type MediaSource, type OutboundContent } from '@botmesh/core'
import { fetchBuffer, SecureHttpError, type HostResolver } from '@botmesh/http'

export type WAMediaUpload =
  | Buffer
  | { url: string }
  | { stream: NodeJS.ReadableStream }

/** Normalize any MediaSource into a Baileys WAMediaUpload. */
export function toMediaUpload(source: MediaSource): WAMediaUpload {
  if (typeof source === 'string') {
    // URL → leave as URL (Baileys streams)
    if (/^https?:\/\//i.test(source) || !existsSync(source)) {
      return { url: source }
    }
    // Local path → Buffer (could also be { url: 'file://...' })
    return readFileSync(source)
  }
  if (Buffer.isBuffer(source)) return source
  if ((source as any).url) return { url: (source as any).url }
  if ((source as any).buffer) return (source as any).buffer
  if ((source as any).path) return readFileSync((source as any).path)
  if ((source as any).stream) return { stream: (source as any).stream }
  throw new Error(`Invalid MediaSource: ${typeof source}`)
}

/**
 * How the provider fetches outbound `{ url }` / `https://…` media.
 *
 * Baileys downloads URL media with plain `fetch`, which follows redirects
 * without checking where they land: a public URL that redirects to
 * `http://169.254.169.254/…` would make the bot fetch (and send) internal data.
 * By default the provider downloads remote media itself through
 * `@botmesh/http` (every redirect hop vetted, connection pinned to the vetted
 * address, size and time capped) and hands Baileys a Buffer.
 */
export interface RemoteMediaConfig {
  /**
   * Accept media hosted on (or redirecting to) loopback, private or link-local
   * addresses. `true` restores the legacy behavior: the URL is passed to
   * Baileys untouched and streamed by it. Default `false`.
   */
  allowPrivateHosts?: boolean
  /** Accept plain `http:` URLs (each hop is still vetted). Default `true`. */
  allowHttp?: boolean
  /** Largest media accepted, in bytes. Default 64 MiB. */
  maxBytes?: number
  /** Time allowed for the whole download. Default 60 s. */
  timeoutMs?: number
  /** Redirect hops allowed. Default 3. */
  maxRedirects?: number
  /** DNS resolver used to vet hosts (tests, egress gateways). */
  resolver?: HostResolver
  /** Custom fetch (tests, egress proxies). */
  fetch?: typeof globalThis.fetch
}

export const REMOTE_MEDIA_MAX_BYTES = 64 * 1024 * 1024

/**
 * Download `{ url }` media through `@botmesh/http` and return a Buffer, unless
 * {@link RemoteMediaConfig.allowPrivateHosts} opts back into the pass-through.
 * Rejects with {@link PayloadTooLargeError} over the size cap and
 * {@link UnsupportedContentError} for an unsafe or failing URL.
 */
export async function resolveRemoteMedia(
  upload: WAMediaUpload,
  kind: OutboundContent['kind'],
  config: RemoteMediaConfig = {},
): Promise<WAMediaUpload> {
  if (Buffer.isBuffer(upload) || !('url' in upload) || !/^https?:\/\//i.test(upload.url)) return upload
  if (config.allowPrivateHosts === true) return upload
  try {
    return await fetchBuffer(upload.url, {
      allowHttp: config.allowHttp !== false,
      maxBytes: config.maxBytes ?? REMOTE_MEDIA_MAX_BYTES,
      timeoutMs: config.timeoutMs ?? 60_000,
      ...(config.maxRedirects !== undefined ? { maxRedirects: config.maxRedirects } : {}),
      ...(config.resolver ? { resolver: config.resolver } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    })
  } catch (error) {
    if (error instanceof SecureHttpError && error.code === 'RESPONSE_TOO_LARGE') {
      throw new PayloadTooLargeError(`${kind} media exceeds ${config.maxBytes ?? REMOTE_MEDIA_MAX_BYTES} bytes`)
    }
    const reason = error instanceof SecureHttpError ? error.message : 'download failed'
    const wrapped = new UnsupportedContentError(kind, `${kind} media URL rejected: ${reason}`)
    ;(wrapped as { cause?: unknown }).cause = error
    throw wrapped
  }
}

/** Read a MediaSource fully into a Buffer (used by sticker/audio transcode). */
export async function toBuffer(source: MediaSource): Promise<Buffer> {
  if (typeof source === 'string') {
    if (/^https?:\/\//i.test(source)) {
      throw new Error('Remote URL not supported here — download it first')
    }
    return readFile(source)
  }
  if (Buffer.isBuffer(source)) return source
  if ((source as any).buffer) return (source as any).buffer
  if ((source as any).path) return readFile((source as any).path)
  throw new Error('Cannot convert this MediaSource to buffer')
}

/* =============================================================================
 * STICKERS
 * ========================================================================== */

export interface StickerOptions {
  pack?: string
  author?: string
}

export async function makeSticker(source: MediaSource, opts: StickerOptions = {}): Promise<Buffer> {
  const buffer = await toBuffer(source)
  // PNG/WebP 512×512 transparent padding ( whatsapp sticker spec )
  const padded = await sharp(buffer, { failOn: 'none' })
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: 0, bottom: 0, left: 0, right: 0,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp()
    .toBuffer()

  if (!opts.pack && !opts.author) return padded
  // EXIF packing with author/pack metadata omitted for now; returns plain WebP
  return padded
}

/* =============================================================================
 * AUDIO (PTT transcode)
 * ========================================================================== */

import { writeFile, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'

export async function transcodeToOpus(source: MediaSource): Promise<Buffer> {
  const input = await toBuffer(source)
  const inPath = join(tmpdir(), `baileys-in-${randomUUID()}.bin`)
  const outPath = join(tmpdir(), `baileys-out-${randomUUID()}.ogg`)
  await writeFile(inPath, input)

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .outputOptions([
          '-c:a libopus',
          '-ac 1',
          '-avoid_negative_ts make_zero',
          '-ar 48000',
        ])
        .output(outPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run()
    })
    return await readFile(outPath)
  } finally {
    // Always clean up both temp files — even when ffmpeg rejects — so a stream
    // of failed transcodes can't leak the OS temp dir.
    await unlink(inPath).catch(() => {})
    await unlink(outPath).catch(() => {})
  }
}
