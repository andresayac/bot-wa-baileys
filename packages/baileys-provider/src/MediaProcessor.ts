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

import type { MediaSource } from '@bot-wa/bot-wa-baileys'

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

  try { await unlink(inPath) } catch {}
  const buf = await readFile(outPath)
  try { await unlink(outPath) } catch {}
  return buf
}
