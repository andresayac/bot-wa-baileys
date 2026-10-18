/**
 * @bot-wa/voice — speech-to-text and text-to-speech for @bot-wa/core bots.
 *
 * @example
 * ```ts
 * import { VOICE_NOTE } from '@bot-wa/core'
 * import { voicePlugin } from '@bot-wa/voice'
 *
 * bot.plug(voicePlugin({
 *   stt: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
 *   tts: { provider: 'openai', voice: 'nova' },
 * }))
 *
 * bot.when('hola', (ctx) => ctx.reply('¡Hola! 👋'))        // also matches a voice note saying "hola"
 * bot.when(VOICE_NOTE, (ctx) => ctx.reply(`Dijiste: ${ctx.transcript}`))
 * ```
 */

import type { VoiceClient } from './VoiceClient.js'

export { voicePlugin, trimPunctuation } from './plugin.js'
export type {
  VoicePluginConfig,
  AutoTranscribeOptions,
  AutoReplyWithVoiceOptions,
  TranscribableType,
} from './plugin.js'
export { VoiceClient, DEFAULT_VOICE_LIMITS } from './VoiceClient.js'
export type { VoiceClientOptions, VoiceLimits, ResolvedVoiceLimits, TranscribeSource } from './VoiceClient.js'
export { resolveStt, resolveTts } from './resolve.js'
export type { SttConfig, TtsConfig, SttProviderName, TtsProviderName } from './resolve.js'
export { openaiStt } from './stt/openai.js'
export type { OpenAISttOptions } from './stt/openai.js'
export { deepgramStt } from './stt/deepgram.js'
export type { DeepgramSttOptions } from './stt/deepgram.js'
export { openaiTts, OPENAI_TTS_MIMETYPES } from './tts/openai.js'
export type { OpenAITtsOptions, OpenAITtsFormat } from './tts/openai.js'
export { elevenlabsTts, elevenLabsMimetype } from './tts/elevenlabs.js'
export type { ElevenLabsTtsOptions } from './tts/elevenlabs.js'
export {
  VoiceError,
  VoiceConfigError,
  AudioTooLargeError,
  AudioTooLongError,
  TextTooLongError,
  VoiceTimeoutError,
  VoiceHttpError,
  VoiceRateLimitedError,
} from './errors.js'
export type { VoiceErrorCode } from './errors.js'
export { estimateOggDurationSec, estimateDurationSec, sniffMimetype } from './audio.js'
export type {
  AudioInput,
  Transcription,
  TranscribeOptions,
  SynthesizedAudio,
  SynthesizeOptions,
  SttAdapter,
  TtsAdapter,
  VoiceHttpOptions,
} from './types.js'

/**
 * Augment `@bot-wa/core`: `ctx.tools.voice` is typed as {@link VoiceClient}
 * (present once `voicePlugin` is plugged), and message contexts gain the
 * transcript fields written by the `autoTranscribe` hook.
 */
declare module '@bot-wa/core' {
  interface DefaultTools {
    /** Injected by `voicePlugin` via `bot.provide('voice', client)`. */
    voice: VoiceClient
  }
  interface MessageContext<TTools extends object = DefaultTools, TRaw = unknown> {
    /** Transcript of an inbound voice note (set by `voicePlugin`'s `autoTranscribe`; `''` = silence). */
    transcript?: string
    /** Why `autoTranscribe` could not produce `transcript` for this message. */
    transcriptError?: unknown
  }
}
