export type { AIMessage } from '@bot-wa/core'
import type { AIMessage, StreamOptions } from '@bot-wa/core'
import type { PresetName } from './providers/presets.js'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Which AI backend to use. Besides the three native providers, any OpenAI-
 * compatible preset (DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral,
 * Grok, Together) is accepted — each resolves to the OpenAI client pointed at
 * that vendor's endpoint.
 */
export type AIProviderName = 'anthropic' | 'openai' | 'ollama' | 'gemini' | PresetName

export interface GenerateInput {
  system?: string
  messages: AIMessage[]
  model?: string
  maxTokens?: number
  effort?: Effort
  signal?: AbortSignal
}
export interface GenerateResult {
  text: string
  model: string
  stopReason?: string
  usage?: { input: number; output: number }
}
export interface AIProvider {
  readonly name: string
  generate(input: GenerateInput): Promise<GenerateResult>
  stream(input: GenerateInput): AsyncIterable<string>
}
export interface AIConfig {
  provider?: AIProviderName
  model?: string
  apiKey?: string
  baseUrl?: string
  persona?: string
  maxTokens?: number
  effort?: Effort
  /**
   * Hard timeout (ms) for a single non-streaming AI call. On expiry the request
   * is aborted (via AbortSignal where the SDK honors it) AND the promise rejects,
   * so a hung provider can never block the per-chat FIFO queue forever.
   * Default 60000. Set 0 to disable (not recommended for the autoresponder).
   */
  timeoutMs?: number
  context?: { maxMessages?: number }
  autoReply?: boolean
  resetCommand?: boolean
  errorMessage?: string
  refusalMessage?: string
  humanizeTyping?: boolean
  /**
   * Stream the autoresponder's answer with `ctx.stream()` (native drafts on
   * Telegram, live edits on Discord, sentence chunks with typing on WhatsApp)
   * instead of one message at the end. `true` uses the defaults; an object tunes
   * the `StreamOptions`. Default: off (one message). Falls back to the one-shot
   * reply when the core has no `ctx.stream`.
   */
  stream?: boolean | AIStreamConfig
}

/** {@link AIConfig.stream} as an object: `StreamOptions` for the autoresponder. */
export type AIStreamConfig = Omit<StreamOptions, 'signal' | 'sendOptions'> & {
  /** Default true; `false` disables streaming while keeping the options around. */
  enabled?: boolean
}
