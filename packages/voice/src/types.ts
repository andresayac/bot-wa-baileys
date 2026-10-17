/**
 * Public types of `@bot-wa/voice`: the STT/TTS adapter contracts and the
 * shared HTTP knobs every built-in adapter accepts.
 */

import type { HostResolver } from '@bot-wa/http'

/** Audio handed to a speech-to-text adapter. */
export interface AudioInput {
  buffer: Buffer
  /** e.g. `audio/ogg; codecs=opus` (WhatsApp/Telegram voice notes). Defaults to `audio/ogg`. */
  mimetype?: string
  /** File name sent to services that want one (multipart uploads). */
  filename?: string
  /** Duration when the caller already knows it (skips the OGG estimate for the duration limit). */
  durationSec?: number
}

/** Per-call STT options. */
export interface TranscribeOptions {
  /** BCP-47 / ISO-639-1 hint, e.g. `'es'`. Overrides the adapter default. */
  language?: string
  /** Free-text context that helps the model (OpenAI `prompt`). Ignored where unsupported. */
  prompt?: string
  /** Abort the request. */
  signal?: AbortSignal
}

/** Result of a transcription. */
export interface Transcription {
  text: string
  /** Detected or requested language, when the service reports it. */
  language?: string
  /** Audio duration in seconds, when the service reports it. */
  durationSec?: number
  /** Adapter that produced it (`'openai'`, `'deepgram'`, …). */
  provider: string
}

/** Per-call TTS options. */
export interface SynthesizeOptions {
  /** Voice override (OpenAI voice name, ElevenLabs voice id). */
  voice?: string
  /** Extra style instructions (OpenAI `gpt-4o-mini-tts`). Ignored where unsupported. */
  instructions?: string
  /** Abort the request. */
  signal?: AbortSignal
}

/** Synthesized audio. */
export interface SynthesizedAudio {
  buffer: Buffer
  /** e.g. `audio/ogg; codecs=opus`, `audio/mpeg`. */
  mimetype: string
  /** Short format tag: `opus`, `mp3`, `wav`, `aac`, `flac`, `pcm`, `ulaw`, … */
  format: string
  /** Adapter that produced it. */
  provider: string
}

/** A speech-to-text backend. Implement it to plug any service (or a local model). */
export interface SttAdapter {
  readonly name: string
  transcribe(audio: AudioInput, options?: TranscribeOptions): Promise<Transcription>
}

/** A text-to-speech backend. Implement it to plug any service (or a local engine). */
export interface TtsAdapter {
  readonly name: string
  synthesize(text: string, options?: SynthesizeOptions): Promise<SynthesizedAudio>
}

/**
 * Shared HTTP options of the built-in adapters. Requests go through
 * `secureFetch` from `@bot-wa/http` (HTTPS only, SSRF guard, timeouts, size caps).
 */
export interface VoiceHttpOptions {
  /** Override the service base URL (proxies, Azure-compatible gateways, self-hosted servers). */
  baseUrl?: string
  /** Per-request timeout in ms. Default `60_000`. */
  timeoutMs?: number
  /** Max bytes accepted in the response. Default 16 MiB (TTS audio) / 1 MiB (STT JSON). */
  maxResponseBytes?: number
  /** Allow `http://` base URLs (self-hosted servers on a trusted network). Default `false`. */
  allowHttp?: boolean
  /** Allow private/loopback hosts (self-hosted servers on a trusted network). Default `false`. */
  allowPrivateHosts?: boolean
  /** TEST/advanced: custom fetch implementation. */
  fetch?: typeof globalThis.fetch
  /** TEST/advanced: custom DNS resolver (e.g. an egress gateway). */
  resolver?: HostResolver
}
