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
  context?: { maxMessages?: number }
  autoReply?: boolean
  resetCommand?: boolean
  errorMessage?: string
  refusalMessage?: string
  humanizeTyping?: boolean
}
