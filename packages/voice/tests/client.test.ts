import { describe, expect, it } from 'vitest'
import {
  AudioTooLargeError,
  AudioTooLongError,
  TextTooLongError,
  VoiceClient,
  VoiceConfigError,
  VoiceError,
  VoiceTimeoutError,
  type AudioInput,
  type SttAdapter,
  type TtsAdapter,
} from '../src/index.js'
import { createTestBot } from '@bot-wa/core/testing'
import type { MessageContext } from '@bot-wa/core'
import { Readable } from 'node:stream'
import { fakeFetch, json, makeOgg, publicResolver } from './helpers.js'

function fakeStt(text = 'hola'): SttAdapter & { inputs: AudioInput[] } {
  const inputs: AudioInput[] = []
  return {
    name: 'fake-stt',
    inputs,
    async transcribe(audio) { inputs.push(audio); return { text, provider: 'fake-stt' } },
  }
}

function fakeTts(): TtsAdapter & { texts: string[] } {
  const texts: string[] = []
  return {
    name: 'fake-tts',
    texts,
    async synthesize(text) { texts.push(text); return { buffer: Buffer.from(`audio:${text}`), mimetype: 'audio/ogg; codecs=opus', format: 'opus', provider: 'fake-tts' } },
  }
}

describe('VoiceClient', () => {
  it('transcribes a Buffer, an AudioInput or a MediaPayload', async () => {
    const stt = fakeStt()
    const client = new VoiceClient({ stt })
    const audio = makeOgg(2)
    expect(await client.transcribe(audio)).toBe('hola')
    expect(await client.transcribe({ buffer: audio, mimetype: 'audio/ogg' })).toBe('hola')
    expect(await client.transcribeDetailed({ buffer: audio, mimetype: 'audio/ogg', filename: 'x.ogg', size: audio.length }))
      .toEqual({ text: 'hola', provider: 'fake-stt' })
    expect(stt.inputs).toHaveLength(3)
  })

  it('rejects missing/empty media with NO_MEDIA', async () => {
    const client = new VoiceClient({ stt: fakeStt() })
    await expect(client.transcribe(undefined)).rejects.toMatchObject({ code: 'NO_MEDIA' })
    await expect(client.transcribe(Buffer.alloc(0))).rejects.toMatchObject({ code: 'NO_MEDIA' })
  })

  it('enforces maxInputBytes and maxDurationSec before calling the adapter', async () => {
    const stt = fakeStt()
    const client = new VoiceClient({ stt, limits: { maxInputBytes: 1000, maxDurationSec: 10 } })
    await expect(client.transcribe(Buffer.alloc(1001, 1))).rejects.toBeInstanceOf(AudioTooLargeError)
    await expect(client.transcribe(makeOgg(11))).rejects.toBeInstanceOf(AudioTooLongError)
    // Caller-provided duration wins over the estimate.
    await expect(client.transcribe({ buffer: Buffer.alloc(10, 1), durationSec: 30 })).rejects.toBeInstanceOf(AudioTooLongError)
    expect(stt.inputs).toHaveLength(0)
    expect(await client.transcribe(makeOgg(9))).toBe('hola')
  })

  it('times out slow adapters and aborts their signal', async () => {
    let seen: AbortSignal | undefined
    const slow: SttAdapter = {
      name: 'slow',
      transcribe: (_audio, opts) => { seen = opts?.signal; return new Promise(() => {}) },
    }
    const client = new VoiceClient({ stt: slow, limits: { timeoutMs: 20 } })
    const err = await client.transcribe(makeOgg(1)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceTimeoutError)
    expect((err as VoiceTimeoutError).service).toBe('slow')
    expect(seen?.aborted).toBe(true)
  })

  it('synthesizes with text limits', async () => {
    const tts = fakeTts()
    const client = new VoiceClient({ tts, limits: { maxTextChars: 5 } })
    expect((await client.synthesize(' hola ')).toString()).toBe('audio:hola')
    expect(tts.texts).toEqual(['hola'])
    await expect(client.synthesize('demasiado')).rejects.toBeInstanceOf(TextTooLongError)
    await expect(client.synthesize('   ')).rejects.toMatchObject({ code: 'NO_MEDIA' })
    const detailed = await client.synthesizeDetailed('ok')
    expect(detailed).toMatchObject({ mimetype: 'audio/ogg; codecs=opus', format: 'opus' })
  })

  it('speak() synthesizes and sends through ctx.voice', async () => {
    const client = new VoiceClient({ tts: fakeTts() })
    const sent: unknown[] = []
    const ctx = { voice: async (media: unknown) => { sent.push(media); return { ref: { id: '1', chatId: 'c' }, id: '1', chatId: 'c' } } }
    await client.speak(ctx, 'hola')
    expect(sent).toEqual([Buffer.from('audio:hola')])
  })

  it('resolves adapters lazily: a bad spec only fails on use / warmup', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const client = new VoiceClient({ stt: { provider: 'openai' }, tts: { provider: 'nope' } as never })
      expect(client.hasStt).toBe(true)
      await expect(client.warmup()).rejects.toBeInstanceOf(VoiceConfigError)
      await expect(client.transcribe(makeOgg(1))).rejects.toBeInstanceOf(VoiceConfigError)
      await expect(client.synthesize('x')).rejects.toBeInstanceOf(VoiceConfigError)
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved
    }
  })

  it('reports a clear error when STT/TTS is not configured', async () => {
    const client = new VoiceClient()
    expect(client.hasStt).toBe(false)
    expect(client.hasTts).toBe(false)
    await expect(client.transcribe(makeOgg(1))).rejects.toThrow(/speech-to-text is not configured/)
    await expect(client.synthesize('x')).rejects.toThrow(/text-to-speech is not configured/)
    await expect(client.warmup()).resolves.toBeUndefined()
  })

  it('works end-to-end with a built-in spec and a fake fetch', async () => {
    const { fetch, calls } = fakeFetch(() => json({ text: 'desde whisper' }))
    const client = new VoiceClient({ stt: { provider: 'openai', apiKey: 'k', fetch, resolver: publicResolver } })
    expect(await client.transcribe(makeOgg(1))).toBe('desde whisper')
    expect(calls).toHaveLength(1)
  })

  it('forwards limits.timeoutMs to the adapter as the per-call timeout', async () => {
    const seen: Array<number | undefined> = []
    const stt: SttAdapter = { name: 's', async transcribe(_a, o) { seen.push(o?.timeoutMs); return { text: 'x', provider: 's' } } }
    const tts: TtsAdapter = {
      name: 't',
      async synthesize(_t, o) { seen.push(o?.timeoutMs); return { buffer: Buffer.from('a'), mimetype: 'audio/ogg', format: 'opus', provider: 't' } },
    }
    const client = new VoiceClient({ stt, tts, limits: { timeoutMs: 180_000 } })
    await client.transcribe(makeOgg(1))
    await client.synthesize('hola')
    expect(seen).toEqual([180_000, 180_000])
  })

  describe('transcribing a message context', () => {
    async function capture(download: () => Promise<Buffer | NodeJS.ReadableStream>, limits = {}) {
      const { bot, chat, provider } = await createTestBot()
      let downloads = 0
      provider.downloadMedia = (async () => { downloads++; return download() }) as unknown as typeof provider.downloadMedia
      const client = new VoiceClient({ stt: fakeStt(), limits })
      const results: unknown[] = []
      bot.onMessage(async (ctx: MessageContext) => {
        results.push(await client.transcribe(ctx).catch((e: unknown) => e))
      })
      await chat.send('', { type: 'voice' })
      const start = Date.now()
      while (results.length === 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5))
      await bot.stop()
      return { result: results[0], downloads: () => downloads }
    }

    it('cuts an oversized download at maxInputBytes instead of buffering all of it', async () => {
      let pulled = 0
      const stream = new Readable({ read() { pulled++; this.push(pulled > 1000 ? null : Buffer.alloc(1024, 1)) } })
      const { result } = await capture(async () => stream, { maxInputBytes: 4096 })
      expect(result).toBeInstanceOf(AudioTooLargeError)
      expect((result as AudioTooLargeError).code).toBe('AUDIO_TOO_LARGE')
      expect(pulled).toBeLessThan(20)
    })

    it('reports a failed download as a NETWORK error, not NO_MEDIA', async () => {
      const { result } = await capture(async () => { throw new Error('socket hang up') })
      expect(result).toBeInstanceOf(VoiceError)
      expect(result).toMatchObject({ code: 'NETWORK' })
      expect((result as Error).message).toMatch(/download/)
    })
  })
})
