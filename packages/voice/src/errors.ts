/**
 * Typed errors raised by `@bot-wa/voice`.
 *
 * Every error is a {@link VoiceError} with a stable `code`, so callers can branch
 * without string-matching messages. Messages never include api keys, audio bytes
 * or transcripts.
 */

export type VoiceErrorCode =
  | 'CONFIG'          // missing api key, unknown provider, STT/TTS not configured
  | 'NO_MEDIA'        // nothing to transcribe (no media on the message / empty buffer)
  | 'AUDIO_TOO_LARGE' // input audio over `limits.maxInputBytes`
  | 'AUDIO_TOO_LONG'  // input audio over `limits.maxDurationSec`
  | 'TEXT_TOO_LONG'   // TTS input over `limits.maxTextChars`
  | 'TIMEOUT'         // the STT/TTS request exceeded `limits.timeoutMs`
  | 'HTTP'            // the STT/TTS service answered with a non-2xx status
  | 'RATE_LIMITED'    // the STT/TTS service answered 429
  | 'NETWORK'         // transport failure / unsafe URL / oversized response
  | 'BAD_RESPONSE'    // the service answered 2xx with an unexpected body

/** Base class of every error thrown by `@bot-wa/voice`. */
export class VoiceError extends Error {
  constructor(message: string, readonly code: VoiceErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'VoiceError'
  }
}

/** Misconfiguration: missing api key, unknown provider, or STT/TTS not configured. */
export class VoiceConfigError extends VoiceError {
  constructor(message: string) {
    super(message, 'CONFIG')
    this.name = 'VoiceConfigError'
  }
}

/** The input audio exceeds `limits.maxInputBytes`. */
export class AudioTooLargeError extends VoiceError {
  constructor(readonly size: number, readonly maxBytes: number) {
    super(`audio is ${size} bytes, over the ${maxBytes}-byte limit`, 'AUDIO_TOO_LARGE')
    this.name = 'AudioTooLargeError'
  }
}

/** The input audio exceeds `limits.maxDurationSec`. */
export class AudioTooLongError extends VoiceError {
  constructor(readonly durationSec: number, readonly maxDurationSec: number) {
    super(`audio lasts ${durationSec.toFixed(1)}s, over the ${maxDurationSec}s limit`, 'AUDIO_TOO_LONG')
    this.name = 'AudioTooLongError'
  }
}

/** The text to synthesize exceeds `limits.maxTextChars`. */
export class TextTooLongError extends VoiceError {
  constructor(readonly length: number, readonly maxChars: number) {
    super(`text has ${length} characters, over the ${maxChars}-character limit`, 'TEXT_TOO_LONG')
    this.name = 'TextTooLongError'
  }
}

/** An STT/TTS request took longer than `limits.timeoutMs`. */
export class VoiceTimeoutError extends VoiceError {
  constructor(readonly service: string, readonly timeoutMs: number, options?: { cause?: unknown }) {
    super(`${service} request timed out after ${timeoutMs}ms`, 'TIMEOUT', options)
    this.name = 'VoiceTimeoutError'
  }
}

/** The STT/TTS service answered with a non-2xx HTTP status. */
export class VoiceHttpError extends VoiceError {
  constructor(
    readonly service: string,
    readonly status: number,
    detail?: string,
    code: 'HTTP' | 'RATE_LIMITED' = 'HTTP',
  ) {
    super(`${service} answered HTTP ${status}${detail ? `: ${detail}` : ''}`, code)
    this.name = 'VoiceHttpError'
  }
}

/** The STT/TTS service answered 429; `retryAfterMs` comes from `Retry-After` when present. */
export class VoiceRateLimitedError extends VoiceHttpError {
  constructor(service: string, readonly retryAfterMs?: number, detail?: string) {
    super(service, 429, detail, 'RATE_LIMITED')
    this.name = 'VoiceRateLimitedError'
  }
}
