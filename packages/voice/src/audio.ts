/**
 * Small, dependency-free audio helpers: mimetype normalization, file names for
 * multipart uploads and a duration estimate for OGG (Opus/Vorbis) — the format
 * of WhatsApp and Telegram voice notes — used to enforce `maxDurationSec`
 * BEFORE paying for a transcription.
 *
 * No transcoding happens here. Providers already convert outbound voice notes
 * (`@botmesh/baileys` transcodes `kind: 'voice'` to OGG/Opus with ffmpeg); for
 * the other channels ask the TTS service for OGG/Opus directly (see README).
 */

/** Mimetype → canonical extension for the formats STT services accept. */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** Strip parameters (`; codecs=opus`) and lowercase. */
export function baseMimetype(mimetype: string | undefined): string {
  return (mimetype ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * Resolve the effective mimetype of inbound audio. Providers sometimes report
 * nothing or `application/octet-stream`; sniff the container, then fall back to
 * OGG (the voice-note format on WhatsApp/Telegram).
 */
export function effectiveMimetype(buffer: Buffer, mimetype: string | undefined): string {
  const base = baseMimetype(mimetype)
  if (base && base !== 'application/octet-stream') return mimetype!.trim()
  return sniffMimetype(buffer) ?? 'audio/ogg'
}

/** Detect a few common containers from their magic bytes. */
export function sniffMimetype(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined
  if (buffer.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg'
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav'
  if (buffer.toString('latin1', 0, 4) === 'fLaC') return 'audio/flac'
  if (buffer.toString('latin1', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (buffer.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4'
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm'
  if (buffer.toString('latin1', 0, 5) === '#!AMR') return 'audio/amr'
  return undefined
}

/** A file name with an extension STT services recognize (`audio.ogg`, `audio.mp3`, …). */
export function audioFilename(mimetype: string, filename?: string): string {
  if (filename && /\.[a-z0-9]{2,5}$/i.test(filename)) return filename
  const ext = EXTENSIONS[baseMimetype(mimetype)] ?? 'ogg'
  return `${filename ?? 'audio'}.${ext}`
}

/**
 * Estimate the duration of an OGG Opus/Vorbis stream from the granule position
 * of its last page. Returns `undefined` for other containers or malformed data.
 */
export function estimateOggDurationSec(buffer: Buffer): number | undefined {
  if (buffer.length < 28 || buffer.toString('latin1', 0, 4) !== 'OggS') return undefined

  // Sample rate + pre-skip from the identification header in the first page.
  const head = buffer.subarray(0, Math.min(buffer.length, 512))
  let rate: number | undefined
  let preSkip = 0
  const opus = head.indexOf('OpusHead', 0, 'latin1')
  if (opus >= 0 && opus + 12 <= head.length) {
    rate = 48_000 // Opus granule positions always count 48 kHz samples
    preSkip = head.readUInt16LE(opus + 10)
  } else {
    const vorbis = head.indexOf('\x01vorbis', 0, 'latin1')
    if (vorbis >= 0 && vorbis + 16 <= head.length) rate = head.readUInt32LE(vorbis + 12)
  }
  if (!rate) return undefined

  const last = buffer.lastIndexOf('OggS', buffer.length - 4, 'latin1')
  if (last < 0 || last + 14 > buffer.length) return undefined
  const granule = buffer.readBigInt64LE(last + 6)
  if (granule <= 0n) return undefined
  const seconds = (Number(granule) - preSkip) / rate
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** Duration of `buffer` when it can be known without decoding (OGG today). */
export function estimateDurationSec(buffer: Buffer, mimetype: string | undefined): number | undefined {
  const base = baseMimetype(mimetype)
  if (base && !['audio/ogg', 'audio/opus', 'application/ogg', 'application/octet-stream'].includes(base)) return undefined
  return estimateOggDurationSec(buffer)
}
