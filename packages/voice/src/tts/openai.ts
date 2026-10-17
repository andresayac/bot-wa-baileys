/**
 * OpenAI-compatible text-to-speech (`POST /audio/speech`).
 *
 * Defaults to `response_format: 'opus'` — OGG/Opus, the native voice-note format
 * of WhatsApp and Telegram, so no transcoding is needed before `ctx.voice()`.
 */

import { VoiceConfigError } from '../errors.js'
import { joinUrl, voiceRequest } from '../http.js'
import type { SynthesizeOptions, SynthesizedAudio, TtsAdapter, VoiceHttpOptions } from '../types.js'

export type OpenAITtsFormat = 'opus' | 'mp3' | 'aac' | 'flac' | 'wav' | 'pcm'

export interface OpenAITtsOptions extends VoiceHttpOptions {
  /** API key. Falls back to `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Default `'gpt-4o-mini-tts'`. Also `'tts-1'`, `'tts-1-hd'`. */
  model?: string
  /** Default `'alloy'`. */
  voice?: string
  /** Default `'opus'` (OGG/Opus). */
  format?: OpenAITtsFormat
  /** Style instructions (only `gpt-4o-mini-tts`). */
  instructions?: string
  /** 0.25–4.0. */
  speed?: number
  /** Default `https://api.openai.com/v1`. */
  baseUrl?: string
  /** OpenAI organization header. */
  organization?: string
}

const SERVICE = 'openai-tts'

export const OPENAI_TTS_MIMETYPES: Record<OpenAITtsFormat, string> = {
  opus: 'audio/ogg; codecs=opus',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

export function openaiTts(options: OpenAITtsOptions = {}): TtsAdapter {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new VoiceConfigError('openai TTS needs an apiKey (or OPENAI_API_KEY)')
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1'
  const format = options.format ?? 'opus'
  if (!(format in OPENAI_TTS_MIMETYPES)) throw new VoiceConfigError(`openai TTS: unknown format '${String(format)}'`)

  return {
    name: 'openai',
    async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesizedAudio> {
      const payload: Record<string, unknown> = {
        model: options.model ?? 'gpt-4o-mini-tts',
        input: text,
        voice: opts.voice ?? options.voice ?? 'alloy',
        response_format: format,
      }
      const instructions = opts.instructions ?? options.instructions
      if (instructions) payload.instructions = instructions
      if (options.speed !== undefined) payload.speed = options.speed

      const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
      if (options.organization) headers['openai-organization'] = options.organization
      const res = await voiceRequest(
        { service: SERVICE, url: joinUrl(baseUrl, 'audio/speech'), headers, body: JSON.stringify(payload), signal: opts.signal, defaultMaxBytes: 16 * 1024 * 1024 },
        options,
      )
      return { buffer: res.body, mimetype: OPENAI_TTS_MIMETYPES[format], format, provider: 'openai' }
    },
  }
}
