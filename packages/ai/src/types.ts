export type { AIMessage } from '@bot-wa/core'
import type { AIMessage } from '@bot-wa/core'
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
}
