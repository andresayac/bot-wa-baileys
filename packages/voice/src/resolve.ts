/**
 * Turn a declarative `{ provider: 'openai', … }` spec (or a ready adapter) into
 * an adapter. Called lazily by {@link VoiceClient}, never at plugin install.
 */

import { VoiceConfigError } from './errors.js'
import { deepgramStt, type DeepgramSttOptions } from './stt/deepgram.js'
import { openaiStt, type OpenAISttOptions } from './stt/openai.js'
import { elevenlabsTts, type ElevenLabsTtsOptions } from './tts/elevenlabs.js'
import { openaiTts, type OpenAITtsOptions } from './tts/openai.js'
import type { SttAdapter, TtsAdapter } from './types.js'

export type SttProviderName = 'openai' | 'deepgram'
export type TtsProviderName = 'openai' | 'elevenlabs'

/** STT config: a built-in provider spec or any {@link SttAdapter}. */
export type SttConfig =
  | SttAdapter
  | ({ provider: 'openai' } & OpenAISttOptions)
  | ({ provider: 'deepgram' } & DeepgramSttOptions)

/** TTS config: a built-in provider spec or any {@link TtsAdapter}. */
export type TtsConfig =
  | TtsAdapter
  | ({ provider: 'openai' } & OpenAITtsOptions)
  | ({ provider: 'elevenlabs' } & ElevenLabsTtsOptions)

export function resolveStt(config: SttConfig): SttAdapter {
  if (typeof (config as SttAdapter).transcribe === 'function') return config as SttAdapter
  const spec = config as { provider?: unknown }
  switch (spec.provider) {
    case 'openai': return openaiStt(config as OpenAISttOptions)
    case 'deepgram': return deepgramStt(config as DeepgramSttOptions)
    default: throw new VoiceConfigError(`unknown STT provider '${String(spec.provider)}' (expected 'openai' or 'deepgram')`)
  }
}

export function resolveTts(config: TtsConfig): TtsAdapter {
  if (typeof (config as TtsAdapter).synthesize === 'function') return config as TtsAdapter
  const spec = config as { provider?: unknown }
  switch (spec.provider) {
    case 'openai': return openaiTts(config as OpenAITtsOptions)
    case 'elevenlabs': return elevenlabsTts(config as ElevenLabsTtsOptions)
    default: throw new VoiceConfigError(`unknown TTS provider '${String(spec.provider)}' (expected 'openai' or 'elevenlabs')`)
  }
}
