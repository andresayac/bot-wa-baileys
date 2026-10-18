/**
 * VoiceClient — the object injected as `ctx.tools.voice`.
 *
 * Wraps one STT and/or one TTS adapter with lazy resolution (a bad config never
 * throws at plugin install; it surfaces on first use and through `warmup()`),
 * size/duration/text limits and a hard per-call timeout.
 *
 * @example
 * ```ts
 * bot.when(VOICE_NOTE, async (ctx) => {
 *   const text = await ctx.tools.voice.transcribe(ctx)   // or ctx.media / a Buffer
 *   await ctx.reply(`Dijiste: ${text}`)
 *   await ctx.voice(await ctx.tools.voice.synthesize('¡Entendido!'))
 * })
 * ```
 */

import { loadMediaOf, MediaTooLargeError, type MediaPayload, type MessageContext, type SentMessage } from '@bot-wa/core'
import { estimateDurationSec } from './audio.js'
import {
  AudioTooLargeError,
  AudioTooLongError,
  TextTooLongError,
  VoiceConfigError,
  VoiceError,
  VoiceTimeoutError,
} from './errors.js'
import { DEFAULT_TIMEOUT_MS } from './http.js'
import { resolveStt, resolveTts, type SttConfig, type TtsConfig } from './resolve.js'
import type {
  AudioInput,
  SttAdapter,
  SynthesizeOptions,
  SynthesizedAudio,
  TranscribeOptions,
  Transcription,
  TtsAdapter,
} from './types.js'

/** Guard rails applied to every STT/TTS call. */
export interface VoiceLimits {
  /**
   * Max input audio size for STT. Default 25 MiB (the OpenAI upload limit).
   * For a message context it caps the media download itself (declared size
   * first, then the bytes read), so an oversized file is never buffered whole.
   */
  maxInputBytes?: number
  /**
   * Max input audio duration for STT, in seconds. Default `300`. Checked before
   * the request when the duration is known (`AudioInput.durationSec` or an OGG
   * voice note, whose length is read from its last page); otherwise skipped.
   */
  maxDurationSec?: number
  /** Max characters per TTS request. Default `4096` (the OpenAI limit). */
  maxTextChars?: number
  /**
   * Hard timeout for each STT/TTS call, in ms. Default `60_000`. Also passed to
   * the adapter as the per-call `timeoutMs`, so the built-in adapters' HTTP
   * timeout follows it (an adapter-level `timeoutMs` can only tighten it).
   */
  timeoutMs?: number
}

export interface ResolvedVoiceLimits {
  maxInputBytes: number
  maxDurationSec: number
  maxTextChars: number
  timeoutMs: number
}

export const DEFAULT_VOICE_LIMITS: ResolvedVoiceLimits = {
  maxInputBytes: 25 * 1024 * 1024,
  maxDurationSec: 300,
  maxTextChars: 4096,
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

export interface VoiceClientOptions {
  stt?: SttConfig
  tts?: TtsConfig
  limits?: VoiceLimits
}

/** What {@link VoiceClient.transcribe} accepts. */
export type TranscribeSource = Buffer | AudioInput | MediaPayload | MessageContext | null | undefined

function isMessageContext(x: unknown): x is MessageContext {
  return typeof x === 'object' && x !== null && !Buffer.isBuffer(x) &&
    typeof (x as MessageContext).reply === 'function' && typeof (x as MessageContext).type === 'string'
}

export class VoiceClient {
  readonly limits: ResolvedVoiceLimits
  private sttAdapter?: SttAdapter
  private ttsAdapter?: TtsAdapter

  constructor(private readonly options: VoiceClientOptions = {}) {
    this.limits = { ...DEFAULT_VOICE_LIMITS, ...definedOnly(options.limits ?? {}) }
  }

  /** Is speech-to-text configured? */
  get hasStt(): boolean { return this.options.stt !== undefined }
  /** Is text-to-speech configured? */
  get hasTts(): boolean { return this.options.tts !== undefined }

  /** Resolve the configured adapters now; rejects with a {@link VoiceConfigError} on a bad config. */
  async warmup(): Promise<void> {
    if (this.hasStt) this.stt()
    if (this.hasTts) this.tts()
  }

  /** Transcribe audio and return the text (`''` when nothing was said). */
  async transcribe(source: TranscribeSource, options?: TranscribeOptions): Promise<string> {
    return (await this.transcribeDetailed(source, options)).text
  }

  /** Transcribe audio and return text + language/duration metadata. */
  async transcribeDetailed(source: TranscribeSource, options: TranscribeOptions = {}): Promise<Transcription> {
    const stt = this.stt()
    const audio = await this.toAudioInput(source)
    this.checkInput(audio)
    return this.withTimeout(stt.name, options.signal, (signal) => stt.transcribe(audio, { ...options, signal, timeoutMs: this.limits.timeoutMs }))
  }

  /** Synthesize `text` and return the audio bytes (ready for `ctx.voice(buffer)`). */
  async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
    return (await this.synthesizeDetailed(text, options)).buffer
  }

  /** Synthesize `text` and return the audio with its mimetype/format. */
  async synthesizeDetailed(text: string, options: SynthesizeOptions = {}): Promise<SynthesizedAudio> {
    const tts = this.tts()
    const input = text.trim()
    if (!input) throw new VoiceError('nothing to synthesize: text is empty', 'NO_MEDIA')
    if (input.length > this.limits.maxTextChars) throw new TextTooLongError(input.length, this.limits.maxTextChars)
    return this.withTimeout(tts.name, options.signal, (signal) => tts.synthesize(input, { ...options, signal, timeoutMs: this.limits.timeoutMs }))
  }

  /** Synthesize `text` and send it as a voice note to the chat of `ctx`. */
  async speak(ctx: Pick<MessageContext, 'voice'>, text: string, options?: SynthesizeOptions): Promise<SentMessage> {
    return ctx.voice(await this.synthesize(text, options))
  }

  /* ------------------------------------------------------------------ */

  private stt(): SttAdapter {
    if (!this.options.stt) throw new VoiceConfigError('speech-to-text is not configured (pass `stt` to voicePlugin)')
    return (this.sttAdapter ??= resolveStt(this.options.stt))
  }

  private tts(): TtsAdapter {
    if (!this.options.tts) throw new VoiceConfigError('text-to-speech is not configured (pass `tts` to voicePlugin)')
    return (this.ttsAdapter ??= resolveTts(this.options.tts))
  }

  private async toAudioInput(source: TranscribeSource): Promise<AudioInput> {
    let input: AudioInput | undefined
    if (Buffer.isBuffer(source)) input = { buffer: source }
    else if (isMessageContext(source)) {
      const media = await this.download(source)
      if (media) input = { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename }
    } else if (source && Buffer.isBuffer((source as AudioInput).buffer)) input = source as AudioInput
    if (!input || input.buffer.length === 0) throw new VoiceError('nothing to transcribe: no audio media', 'NO_MEDIA')
    return input
  }

  /**
   * Download the message's media with `maxInputBytes` as a hard cap: the declared
   * size is checked before downloading and the download is cut once it goes over,
   * so an oversized file is never buffered whole. A failed download is a `NETWORK` error.
   */
  private async download(ctx: MessageContext): Promise<MediaPayload | undefined> {
    const { maxInputBytes } = this.limits
    try {
      return await loadMediaOf(ctx, { maxBytes: maxInputBytes, throwOnError: true })
    } catch (error) {
      if (error instanceof MediaTooLargeError) throw new AudioTooLargeError(error.bytes, maxInputBytes)
      const reason = error instanceof Error ? error.message : String(error)
      throw new VoiceError(`could not download the audio: ${reason}`, 'NETWORK', { cause: error })
    }
  }

  private checkInput(audio: AudioInput): void {
    const { maxInputBytes, maxDurationSec } = this.limits
    if (audio.buffer.length > maxInputBytes) throw new AudioTooLargeError(audio.buffer.length, maxInputBytes)
    const duration = audio.durationSec ?? estimateDurationSec(audio.buffer, audio.mimetype)
    if (duration !== undefined && duration > maxDurationSec) throw new AudioTooLongError(duration, maxDurationSec)
  }

  /** Race the call against `limits.timeoutMs`, aborting the adapter's request when it fires. */
  private async withTimeout<T>(service: string, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { timeoutMs } = this.limits
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(parent?.reason)
    if (parent?.aborted) controller.abort(parent.reason)
    else parent?.addEventListener('abort', onParentAbort, { once: true })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new VoiceTimeoutError(service, timeoutMs)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    })
    try {
      return await Promise.race([run(controller.signal), timeout])
    } finally {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    }
  }
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
