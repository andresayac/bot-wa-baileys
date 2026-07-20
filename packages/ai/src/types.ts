export type { AIMessage } from '@bot-wa/core'
import type { AIMessage } from '@bot-wa/core'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  provider?: 'anthropic' | 'openai' | 'ollama'
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
