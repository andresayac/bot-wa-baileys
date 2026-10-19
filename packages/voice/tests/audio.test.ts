import { describe, expect, it } from 'vitest'
import { estimateDurationSec, estimateOggDurationSec, sniffMimetype } from '../src/index.js'
import { audioFilename, effectiveMimetype } from '../src/audio.js'
import { encodeMultipart } from '../src/multipart.js'
import { makeOgg } from './helpers.js'

describe('OGG duration estimate', () => {
  it('reads the last page granule of an Opus stream (minus pre-skip)', () => {
    expect(estimateOggDurationSec(makeOgg(12.5))).toBeCloseTo(12.5, 3)
    expect(estimateOggDurationSec(makeOgg(0.75, 0))).toBeCloseTo(0.75, 3)
  })

  it('reads Vorbis streams using their sample rate', () => {
    const head = Buffer.alloc(27 + 30)
    head.write('OggS', 0, 'latin1')
    head.write('\x01vorbis', 27, 'latin1')
    head.writeUInt32LE(44_100, 27 + 12)
    const last = Buffer.alloc(27)
    last.write('OggS', 0, 'latin1')
    last.writeBigInt64LE(BigInt(44_100 * 4), 6)
    expect(estimateOggDurationSec(Buffer.concat([head, last]))).toBeCloseTo(4, 3)
  })

  it('returns undefined for non-OGG or malformed data', () => {
    expect(estimateOggDurationSec(Buffer.from('ID3 not ogg at all, definitely not'))).toBeUndefined()
    const noHead = Buffer.alloc(64)
    noHead.write('OggS', 0, 'latin1')
    expect(estimateOggDurationSec(noHead)).toBeUndefined()
    expect(estimateDurationSec(makeOgg(3), 'audio/mpeg')).toBeUndefined()
    expect(estimateDurationSec(makeOgg(3), 'audio/ogg; codecs=opus')).toBeCloseTo(3, 3)
    expect(estimateDurationSec(makeOgg(3), undefined)).toBeCloseTo(3, 3)
  })
})

describe('mimetype helpers', () => {
  it('sniffs common containers', () => {
    expect(sniffMimetype(makeOgg(1))).toBe('audio/ogg')
    const wav = Buffer.alloc(16); wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1')
    expect(sniffMimetype(wav)).toBe('audio/wav')
    expect(sniffMimetype(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00'))).toBe('audio/mpeg')
    const mp4 = Buffer.alloc(16); mp4.write('ftyp', 4, 'latin1')
    expect(sniffMimetype(mp4)).toBe('audio/mp4')
    expect(sniffMimetype(Buffer.alloc(16))).toBeUndefined()
  })

  it('keeps a reported mimetype, else sniffs, else assumes OGG (voice notes)', () => {
    expect(effectiveMimetype(Buffer.alloc(16), 'audio/mp4')).toBe('audio/mp4')
    expect(effectiveMimetype(makeOgg(1), 'application/octet-stream')).toBe('audio/ogg')
    expect(effectiveMimetype(Buffer.alloc(16), undefined)).toBe('audio/ogg')
  })

  it('builds file names with a known extension', () => {
    expect(audioFilename('audio/ogg; codecs=opus')).toBe('audio.ogg')
    expect(audioFilename('audio/mpeg', 'nota')).toBe('nota.mp3')
    expect(audioFilename('audio/mpeg', 'nota.m4a')).toBe('nota.m4a')
    expect(audioFilename('application/x-unknown')).toBe('audio.ogg')
  })
})

describe('encodeMultipart', () => {
  it('encodes fields and files with CRLF framing', () => {
    const { body, contentType } = encodeMultipart([
      { name: 'model', value: 'whisper-1' },
      { name: 'file', filename: 'a"b.ogg', contentType: 'audio/ogg', data: Buffer.from('DATA') },
    ], 'XYZ')
    expect(contentType).toBe('multipart/form-data; boundary=XYZ')
    expect(body.toString()).toBe(
      '--XYZ\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n' +
      '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a%22b.ogg"\r\nContent-Type: audio/ogg\r\n\r\nDATA\r\n' +
      '--XYZ--\r\n',
    )
  })

  it('never lets a part content type inject headers or extra fields (it can come from an inbound message)', () => {
    const { body } = encodeMultipart([
      { name: 'file', filename: 'a.ogg', contentType: 'audio/ogg\r\n\r\n--XYZ\r\nContent-Disposition: form-data; name="model"\r\n\r\nevil', data: Buffer.from('D') },
    ], 'XYZ')
    const text = body.toString()
    expect(text.match(/Content-Disposition/g)).toHaveLength(1)
    expect(text).not.toMatch(/name="model"\r\n/)
  })
})

describe('trimPunctuation', () => {
  it('strips surrounding punctuation and whitespace only', async () => {
    const { trimPunctuation } = await import('../src/index.js')
    expect(trimPunctuation(' ¡Hola! ')).toBe('Hola')
    expect(trimPunctuation('Sí.')).toBe('Sí')
    expect(trimPunctuation('¿Mi pedido 12, por favor?')).toBe('Mi pedido 12, por favor')
    expect(trimPunctuation('...')).toBe('')
    expect(trimPunctuation('«50%»')).toBe('50%')
    expect(trimPunctuation('#123.')).toBe('#123')
  })
})
