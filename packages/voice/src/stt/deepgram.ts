/**
 * Deepgram pre-recorded speech-to-text (`POST /v1/listen`, raw audio body).
 */

import { effectiveMimetype } from '../audio.js'
import { VoiceConfigError, VoiceError } from '../errors.js'
import { joinUrl, parseJson, voiceRequest } from '../http.js'
import type { AudioInput, SttAdapter, TranscribeOptions, Transcription, VoiceHttpOptions } from '../types.js'

export interface DeepgramSttOptions extends VoiceHttpOptions {
  /** API key. Falls back to `process.env.DEEPGRAM_API_KEY`. */
  apiKey?: string
  /** Default `'nova-3'`. */
  model?: string
  /** Language hint (e.g. `'es'`). When omitted, `detect_language=true` is sent. */
  language?: string
  /** Punctuation + formatting. Default `true`. */
  smartFormat?: boolean
  /** Extra query parameters passed verbatim (e.g. `{ keyterm: 'BotWA' }`). */
  query?: Record<string, string>
  /** Default `https://api.deepgram.com/v1`. */
  baseUrl?: string
}

const SERVICE = 'deepgram-stt'

interface DeepgramResponse {
  metadata?: { duration?: unknown }
  results?: { channels?: Array<{ detected_language?: unknown; alternatives?: Array<{ transcript?: unknown }> }> }
}

export function deepgramStt(options: DeepgramSttOptions = {}): SttAdapter {
  const apiKey = options.apiKey ?? process.env.DEEPGRAM_API_KEY
  if (!apiKey) throw new VoiceConfigError('deepgram STT needs an apiKey (or DEEPGRAM_API_KEY)')
  const baseUrl = options.baseUrl ?? 'https://api.deepgram.com/v1'

  return {
    name: 'deepgram',
    async transcribe(audio: AudioInput, opts: TranscribeOptions = {}): Promise<Transcription> {
      const params = new URLSearchParams({ model: options.model ?? 'nova-3', smart_format: String(options.smartFormat ?? true) })
      const language = opts.language ?? options.language
      if (language) params.set('language', language)
      else params.set('detect_language', 'true')
      for (const [k, v] of Object.entries(options.query ?? {})) params.set(k, v)

      const res = await voiceRequest(
        {
          service: SERVICE,
          url: `${joinUrl(baseUrl, 'listen')}?${params.toString()}`,
          headers: { authorization: `Token ${apiKey}`, 'content-type': effectiveMimetype(audio.buffer, audio.mimetype) },
          body: audio.buffer,
          signal: opts.signal, timeoutMs: opts.timeoutMs,
          defaultMaxBytes: 1024 * 1024,
        },
        options,
      )
      const json = parseJson(SERVICE, res.body) as DeepgramResponse
      const channel = json?.results?.channels?.[0]
      const transcript = channel?.alternatives?.[0]?.transcript
      if (typeof transcript !== 'string') throw new VoiceError(`${SERVICE} response has no transcript`, 'BAD_RESPONSE')
      return {
        text: transcript.trim(),
        language: typeof channel?.detected_language === 'string' ? channel.detected_language : language,
        durationSec: typeof json.metadata?.duration === 'number' ? json.metadata.duration : undefined,
        provider: 'deepgram',
      }
    },
  }
}
