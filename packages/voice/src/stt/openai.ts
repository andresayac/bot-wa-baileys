/**
 * OpenAI-compatible speech-to-text (`POST /audio/transcriptions`).
 *
 * Works with `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and any
 * server that speaks the same API (Groq, LocalAI, faster-whisper-server, Azure
 * gateways…) through `baseUrl`.
 */

import { audioFilename, effectiveMimetype } from '../audio.js'
import { VoiceConfigError, VoiceError } from '../errors.js'
import { joinUrl, parseJson, voiceRequest } from '../http.js'
import type { AudioInput, SttAdapter, TranscribeOptions, Transcription, VoiceHttpOptions } from '../types.js'
import { encodeMultipart, type MultipartPart } from '../multipart.js'

export interface OpenAISttOptions extends VoiceHttpOptions {
  /** API key. Falls back to `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Default `'whisper-1'`. Also `'gpt-4o-transcribe'`, `'gpt-4o-mini-transcribe'`. */
  model?: string
  /** Default language hint (ISO-639-1, e.g. `'es'`). */
  language?: string
  /** Default prompt (vocabulary, names, style). */
  prompt?: string
  /** Sampling temperature (0–1). */
  temperature?: number
  /** Default `https://api.openai.com/v1`. */
  baseUrl?: string
  /** OpenAI organization header. */
  organization?: string
}

const SERVICE = 'openai-stt'

export function openaiStt(options: OpenAISttOptions = {}): SttAdapter {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new VoiceConfigError('openai STT needs an apiKey (or OPENAI_API_KEY)')
  const model = options.model ?? 'whisper-1'
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1'
  // whisper-1 can return language + duration (verbose_json); gpt-4o-* only `json`.
  const responseFormat = model.startsWith('whisper') ? 'verbose_json' : 'json'

  return {
    name: 'openai',
    async transcribe(audio: AudioInput, opts: TranscribeOptions = {}): Promise<Transcription> {
      const mimetype = effectiveMimetype(audio.buffer, audio.mimetype)
      const parts: MultipartPart[] = [
        { name: 'file', filename: audioFilename(mimetype, audio.filename), contentType: mimetype, data: audio.buffer },
        { name: 'model', value: model },
        { name: 'response_format', value: responseFormat },
      ]
      const language = opts.language ?? options.language
      if (language) parts.push({ name: 'language', value: language })
      const prompt = opts.prompt ?? options.prompt
      if (prompt) parts.push({ name: 'prompt', value: prompt })
      if (options.temperature !== undefined) parts.push({ name: 'temperature', value: String(options.temperature) })

      const form = encodeMultipart(parts)
      const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': form.contentType }
      if (options.organization) headers['openai-organization'] = options.organization
      const res = await voiceRequest(
        { service: SERVICE, url: joinUrl(baseUrl, 'audio/transcriptions'), headers, body: form.body, signal: opts.signal, defaultMaxBytes: 1024 * 1024 },
        options,
      )
      const json = parseJson(SERVICE, res.body) as { text?: unknown; language?: unknown; duration?: unknown }
      if (typeof json?.text !== 'string') throw new VoiceError(`${SERVICE} response has no text`, 'BAD_RESPONSE')
      return {
        text: json.text.trim(),
        language: typeof json.language === 'string' ? json.language : language,
        durationSec: typeof json.duration === 'number' ? json.duration : undefined,
        provider: 'openai',
      }
    },
  }
}
