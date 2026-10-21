/**
 * ElevenLabs text-to-speech (`POST /v1/text-to-speech/{voice_id}`).
 *
 * The default `outputFormat` is `mp3_44100_128` (available on every plan). For
 * WhatsApp voice notes `@botmesh/baileys` transcodes to OGG/Opus itself; on other
 * channels prefer an `opus_48000_*` format if your plan offers it.
 */

import { VoiceConfigError } from '../errors.js'
import { joinUrl, voiceRequest } from '../http.js'
import type { SynthesizeOptions, SynthesizedAudio, TtsAdapter, VoiceHttpOptions } from '../types.js'

export interface ElevenLabsTtsOptions extends VoiceHttpOptions {
  /** API key. Falls back to `process.env.ELEVENLABS_API_KEY`. */
  apiKey?: string
  /** Voice id (from the ElevenLabs voice library, e.g. `'21m00Tcm4TlvDq8ikWAM'`). */
  voiceId?: string
  /** Alias of `voiceId`. */
  voice?: string
  /** Default `'eleven_multilingual_v2'`. */
  modelId?: string
  /** `<codec>_<rate>[_<bitrate>]`, e.g. `mp3_44100_128` (default), `opus_48000_64`, `pcm_16000`, `ulaw_8000`. */
  outputFormat?: string
  /** `voice_settings` passed verbatim (`stability`, `similarity_boost`, `style`, `speed`, …). */
  voiceSettings?: Record<string, number | boolean>
  /** ISO-639-1 code enforced on multilingual models. */
  languageCode?: string
  /** Default `https://api.elevenlabs.io/v1`. */
  baseUrl?: string
}

const SERVICE = 'elevenlabs-tts'

/** Map an ElevenLabs `output_format` to `{ mimetype, format }`. */
export function elevenLabsMimetype(outputFormat: string): { mimetype: string; format: string } {
  const codec = outputFormat.split('_')[0]!.toLowerCase()
  switch (codec) {
    case 'mp3': return { mimetype: 'audio/mpeg', format: 'mp3' }
    case 'opus': return { mimetype: 'audio/ogg; codecs=opus', format: 'opus' }
    case 'pcm': return { mimetype: 'audio/pcm', format: 'pcm' }
    case 'wav': return { mimetype: 'audio/wav', format: 'wav' }
    case 'ulaw': return { mimetype: 'audio/basic', format: 'ulaw' }
    case 'alaw': return { mimetype: 'audio/x-alaw-basic', format: 'alaw' }
    default: return { mimetype: 'application/octet-stream', format: codec }
  }
}

export function elevenlabsTts(options: ElevenLabsTtsOptions = {}): TtsAdapter {
  const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new VoiceConfigError('elevenlabs TTS needs an apiKey (or ELEVENLABS_API_KEY)')
  const defaultVoice = options.voiceId ?? options.voice
  const baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io/v1'
  const outputFormat = options.outputFormat ?? 'mp3_44100_128'
  const { mimetype, format } = elevenLabsMimetype(outputFormat)

  return {
    name: 'elevenlabs',
    async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesizedAudio> {
      const voiceId = opts.voice ?? defaultVoice
      if (!voiceId) throw new VoiceConfigError('elevenlabs TTS needs a voiceId')
      const payload: Record<string, unknown> = { text, model_id: options.modelId ?? 'eleven_multilingual_v2' }
      if (options.voiceSettings) payload.voice_settings = options.voiceSettings
      if (options.languageCode) payload.language_code = options.languageCode

      const url = `${joinUrl(baseUrl, `text-to-speech/${encodeURIComponent(voiceId)}`)}?${new URLSearchParams({ output_format: outputFormat })}`
      const res = await voiceRequest(
        {
          service: SERVICE,
          url,
          headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: mimetype.split(';')[0]! },
          body: JSON.stringify(payload),
          signal: opts.signal, timeoutMs: opts.timeoutMs,
          defaultMaxBytes: 16 * 1024 * 1024,
        },
        options,
      )
      return { buffer: res.body, mimetype, format, provider: 'elevenlabs' }
    },
  }
}
