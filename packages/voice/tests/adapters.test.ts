import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deepgramStt,
  elevenlabsTts,
  openaiStt,
  openaiTts,
  resolveStt,
  resolveTts,
  VoiceConfigError,
  VoiceError,
  VoiceHttpError,
  VoiceRateLimitedError,
  VoiceTimeoutError,
} from '../src/index.js'
import { fakeFetch, json, makeOgg, publicResolver } from './helpers.js'

const ENV_KEYS = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY'] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('openaiStt', () => {
  it('posts a multipart upload to /audio/transcriptions and returns text + metadata', async () => {
    const { fetch, calls } = fakeFetch(() => json({ text: ' hola mundo ', language: 'spanish', duration: 2.5 }))
    const stt = openaiStt({ apiKey: 'sk-test', language: 'es', prompt: 'BotWA', fetch, resolver: publicResolver })
    const audio = makeOgg(2.5)

    const result = await stt.transcribe({ buffer: audio, mimetype: 'audio/ogg; codecs=opus' })

    expect(result).toEqual({ text: 'hola mundo', language: 'spanish', durationSec: 2.5, provider: 'openai' })
    expect(calls).toHaveLength(1)
    const req = calls[0]!
    expect(req.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(req.method).toBe('POST')
    expect(req.headers.get('authorization')).toBe('Bearer sk-test')
    expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    const text = req.body.toString('latin1')
    expect(text).toContain('name="file"; filename="audio.ogg"')
    expect(text).toContain('Content-Type: audio/ogg; codecs=opus')
    expect(text).toMatch(/name="model"\r\n\r\nwhisper-1\r\n/)
    expect(text).toMatch(/name="response_format"\r\n\r\nverbose_json\r\n/)
    expect(text).toMatch(/name="language"\r\n\r\nes\r\n/)
    expect(text).toMatch(/name="prompt"\r\n\r\nBotWA\r\n/)
    expect(req.body.includes(audio)).toBe(true)
  })

  it('uses response_format=json for gpt-4o transcribe models and per-call language overrides', async () => {
    const { fetch, calls } = fakeFetch(() => json({ text: 'hi' }))
    const stt = openaiStt({ apiKey: 'k', model: 'gpt-4o-mini-transcribe', language: 'es', baseUrl: 'https://gw.example.com/openai/', fetch, resolver: publicResolver })

    const result = await stt.transcribe({ buffer: Buffer.from('ID3....audio-bytes') }, { language: 'en' })

    expect(result.text).toBe('hi')
    expect(result.language).toBe('en')
    const req = calls[0]!
    expect(req.url).toBe('https://gw.example.com/openai/audio/transcriptions')
    const text = req.body.toString('latin1')
    expect(text).toMatch(/name="response_format"\r\n\r\njson\r\n/)
    expect(text).toMatch(/name="language"\r\n\r\nen\r\n/)
    // Sniffed: an ID3 header means mp3.
    expect(text).toContain('filename="audio.mp3"')
  })

  it('reads the api key from OPENAI_API_KEY and fails fast without one', () => {
    expect(() => openaiStt()).toThrow(VoiceConfigError)
    process.env.OPENAI_API_KEY = 'from-env'
    expect(openaiStt().name).toBe('openai')
  })

  it('maps HTTP errors to VoiceHttpError with the service detail (never the key)', async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: 'Invalid file format.' } }, 400))
    const stt = openaiStt({ apiKey: 'sk-secret', fetch, resolver: publicResolver })
    const err = await stt.transcribe({ buffer: makeOgg(1) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceHttpError)
    expect((err as VoiceHttpError).status).toBe(400)
    expect((err as VoiceHttpError).code).toBe('HTTP')
    expect((err as Error).message).toContain('Invalid file format.')
    expect((err as Error).message).not.toContain('sk-secret')
  })

  it('maps 429 to VoiceRateLimitedError with Retry-After', async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: 'slow down' } }, 429, { 'retry-after': '7' }))
    const stt = openaiStt({ apiKey: 'k', fetch, resolver: publicResolver })
    const err = await stt.transcribe({ buffer: makeOgg(1) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceRateLimitedError)
    expect((err as VoiceRateLimitedError).retryAfterMs).toBe(7000)
    expect((err as VoiceRateLimitedError).code).toBe('RATE_LIMITED')
  })

  it('rejects a 2xx body without text as BAD_RESPONSE', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>', { status: 200 }))
    const stt = openaiStt({ apiKey: 'k', fetch, resolver: publicResolver })
    await expect(stt.transcribe({ buffer: makeOgg(1) })).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('refuses plain-http and private base URLs through secureFetch', async () => {
    const { fetch, calls } = fakeFetch(() => json({ text: 'x' }))
    const http = openaiStt({ apiKey: 'k', baseUrl: 'http://api.example.com/v1', fetch, resolver: publicResolver })
    await expect(http.transcribe({ buffer: makeOgg(1) })).rejects.toMatchObject({ code: 'NETWORK' })
    const priv = openaiStt({ apiKey: 'k', baseUrl: 'https://10.0.0.5/v1', fetch, resolver: async () => ['10.0.0.5'] })
    await expect(priv.transcribe({ buffer: makeOgg(1) })).rejects.toMatchObject({ code: 'NETWORK' })
    expect(calls).toHaveLength(0)

    // Opt-in for self-hosted servers on a trusted network.
    const local = openaiStt({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8000/v1', allowHttp: true, allowPrivateHosts: true, fetch, resolver: async () => ['127.0.0.1'] })
    await expect(local.transcribe({ buffer: makeOgg(1) })).resolves.toMatchObject({ text: 'x' })
  })

  it('maps a request timeout to VoiceTimeoutError', async () => {
    const fetch = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as unknown as typeof globalThis.fetch
    const stt = openaiStt({ apiKey: 'k', timeoutMs: 20, fetch, resolver: publicResolver })
    await expect(stt.transcribe({ buffer: makeOgg(1) })).rejects.toBeInstanceOf(VoiceTimeoutError)
  })
})

describe('deepgramStt', () => {
  it('posts raw audio to /listen with Token auth and query options', async () => {
    const { fetch, calls } = fakeFetch(() => json({
      metadata: { duration: 3.2 },
      results: { channels: [{ detected_language: 'es', alternatives: [{ transcript: 'buenas tardes' }] }] },
    }))
    const stt = deepgramStt({ apiKey: 'dg-key', fetch, resolver: publicResolver, query: { keyterm: 'BotWA' } })
    const audio = makeOgg(3.2)

    const result = await stt.transcribe({ buffer: audio })

    expect(result).toEqual({ text: 'buenas tardes', language: 'es', durationSec: 3.2, provider: 'deepgram' })
    const req = calls[0]!
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen')
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('smart_format')).toBe('true')
    expect(url.searchParams.get('detect_language')).toBe('true')
    expect(url.searchParams.get('keyterm')).toBe('BotWA')
    expect(req.headers.get('authorization')).toBe('Token dg-key')
    expect(req.headers.get('content-type')).toBe('audio/ogg')
    expect(req.body.equals(audio)).toBe(true)
  })

  it('sends language instead of detect_language when given', async () => {
    const { fetch, calls } = fakeFetch(() => json({ results: { channels: [{ alternatives: [{ transcript: '' }] }] } }))
    const stt = deepgramStt({ apiKey: 'k', model: 'nova-2', language: 'es', fetch, resolver: publicResolver })
    const result = await stt.transcribe({ buffer: makeOgg(1), mimetype: 'audio/ogg; codecs=opus' })
    expect(result.text).toBe('')
    expect(result.language).toBe('es')
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('language')).toBe('es')
    expect(url.searchParams.get('model')).toBe('nova-2')
    expect(url.searchParams.has('detect_language')).toBe(false)
  })

  it('needs an api key and reports Deepgram error bodies', async () => {
    expect(() => deepgramStt()).toThrow(VoiceConfigError)
    const { fetch } = fakeFetch(() => json({ err_code: 'Bad Request', err_msg: 'corrupt audio' }, 400))
    const stt = deepgramStt({ apiKey: 'k', fetch, resolver: publicResolver })
    await expect(stt.transcribe({ buffer: makeOgg(1) })).rejects.toThrow(/corrupt audio/)
  })
})

describe('openaiTts', () => {
  it('posts JSON to /audio/speech and returns OGG/Opus by default', async () => {
    const audio = Buffer.from('OggS-fake-audio')
    const { fetch, calls } = fakeFetch(() => new Response(audio, { status: 200, headers: { 'content-type': 'audio/ogg' } }))
    const tts = openaiTts({ apiKey: 'sk', voice: 'nova', instructions: 'cálido', speed: 1.1, fetch, resolver: publicResolver })

    const result = await tts.synthesize('Hola')

    expect(result.buffer.equals(audio)).toBe(true)
    expect(result).toMatchObject({ mimetype: 'audio/ogg; codecs=opus', format: 'opus', provider: 'openai' })
    const req = calls[0]!
    expect(req.url).toBe('https://api.openai.com/v1/audio/speech')
    expect(req.headers.get('authorization')).toBe('Bearer sk')
    expect(JSON.parse(req.body.toString())).toEqual({
      model: 'gpt-4o-mini-tts', input: 'Hola', voice: 'nova', response_format: 'opus', instructions: 'cálido', speed: 1.1,
    })
  })

  it('honours per-call voice and other formats', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(Buffer.from('mp3'), { status: 200 }))
    const tts = openaiTts({ apiKey: 'sk', model: 'tts-1', format: 'mp3', fetch, resolver: publicResolver })
    const result = await tts.synthesize('x', { voice: 'echo' })
    expect(result).toMatchObject({ mimetype: 'audio/mpeg', format: 'mp3' })
    expect(JSON.parse(calls[0]!.body.toString())).toMatchObject({ model: 'tts-1', voice: 'echo', response_format: 'mp3' })
  })

  it('validates config', () => {
    expect(() => openaiTts()).toThrow(VoiceConfigError)
    expect(() => openaiTts({ apiKey: 'k', format: 'ogg' as never })).toThrow(VoiceConfigError)
  })
})

describe('elevenlabsTts', () => {
  it('posts to /text-to-speech/{voiceId} with xi-api-key and output_format', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(Buffer.from('ID3mp3'), { status: 200 }))
    const tts = elevenlabsTts({ apiKey: 'el-key', voiceId: 'voice/123', voiceSettings: { stability: 0.5 }, languageCode: 'es', fetch, resolver: publicResolver })

    const result = await tts.synthesize('Hola')

    expect(result).toMatchObject({ mimetype: 'audio/mpeg', format: 'mp3', provider: 'elevenlabs' })
    const req = calls[0]!
    const url = new URL(req.url)
    expect(url.pathname).toBe('/v1/text-to-speech/voice%2F123')
    expect(url.searchParams.get('output_format')).toBe('mp3_44100_128')
    expect(req.headers.get('xi-api-key')).toBe('el-key')
    expect(req.headers.get('accept')).toBe('audio/mpeg')
    expect(JSON.parse(req.body.toString())).toEqual({
      text: 'Hola', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5 }, language_code: 'es',
    })
  })

  it('maps opus output formats and accepts `voice` as an alias / per-call override', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(Buffer.from('OggS'), { status: 200 }))
    const tts = elevenlabsTts({ apiKey: 'k', voice: 'rachel-id', outputFormat: 'opus_48000_64', fetch, resolver: publicResolver })
    const result = await tts.synthesize('x', { voice: 'other-id' })
    expect(result).toMatchObject({ mimetype: 'audio/ogg; codecs=opus', format: 'opus' })
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/text-to-speech/other-id')
  })

  it('requires an api key and a voice id', async () => {
    expect(() => elevenlabsTts()).toThrow(VoiceConfigError)
    const tts = elevenlabsTts({ apiKey: 'k' })
    await expect(tts.synthesize('x')).rejects.toBeInstanceOf(VoiceConfigError)
  })

  it('surfaces ElevenLabs `detail.message` errors', async () => {
    const { fetch } = fakeFetch(() => json({ detail: { status: 'voice_not_found', message: 'Voice not found' } }, 404))
    const tts = elevenlabsTts({ apiKey: 'k', voiceId: 'v', fetch, resolver: publicResolver })
    const err = await tts.synthesize('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceHttpError)
    expect((err as VoiceError).message).toContain('Voice not found')
  })
})

describe('resolveStt / resolveTts', () => {
  it('builds built-in adapters from specs and passes custom adapters through', () => {
    expect(resolveStt({ provider: 'openai', apiKey: 'k' }).name).toBe('openai')
    expect(resolveStt({ provider: 'deepgram', apiKey: 'k' }).name).toBe('deepgram')
    expect(resolveTts({ provider: 'openai', apiKey: 'k' }).name).toBe('openai')
    expect(resolveTts({ provider: 'elevenlabs', apiKey: 'k', voiceId: 'v' }).name).toBe('elevenlabs')
    const custom = { name: 'local', transcribe: async () => ({ text: '', provider: 'local' }) }
    expect(resolveStt(custom)).toBe(custom)
  })

  it('rejects unknown providers with VoiceConfigError', () => {
    expect(() => resolveStt({ provider: 'nope' } as never)).toThrow(VoiceConfigError)
    expect(() => resolveTts({ provider: 'nope' } as never)).toThrow(VoiceConfigError)
  })
})
