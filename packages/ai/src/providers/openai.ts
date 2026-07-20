import type { AIProvider, GenerateInput, GenerateResult, AIConfig } from '../types.js'

interface ChatMessage {
  role: string
  content: string
}

export interface OpenAIChoice {
  message?: { content?: string }
  finish_reason?: string
}
export interface OpenAIChatCompletion {
  choices: OpenAIChoice[]
  model: string
  usage?: { prompt_tokens: number; completion_tokens: number }
}
export interface OpenAIStreamChunk {
  choices: Array<{ delta?: { content?: string } }>
}
export interface OpenAILike {
  chat: {
    completions: {
      create(args: Record<string, unknown>): Promise<OpenAIChatCompletion | AsyncIterable<OpenAIStreamChunk>>
    }
  }
}

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai'
  constructor(
    private client: OpenAILike,
    private cfg: AIConfig,
  ) {}

  private messagesFor(input: GenerateInput): ChatMessage[] {
    return input.system ? [{ role: 'system', content: input.system }, ...input.messages] : [...input.messages]
  }
  private model(input: GenerateInput): string {
    const m = input.model ?? this.cfg.model
    if (!m) throw new Error('OpenAIProvider requiere `model` en la config (sin default).')
    return m
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = (await this.client.chat.completions.create({
      model: this.model(input),
      messages: this.messagesFor(input),
      // Current OpenAI chat models (o-series, gpt-5 family) reject `max_tokens`.
      max_completion_tokens: input.maxTokens ?? this.cfg.maxTokens ?? 1024,
    })) as OpenAIChatCompletion
    return {
      text: res.choices[0]?.message?.content ?? '',
      model: res.model,
      stopReason: res.choices[0]?.finish_reason,
      usage: res.usage ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens } : undefined,
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const s = (await this.client.chat.completions.create({
      model: this.model(input),
      messages: this.messagesFor(input),
      // Current OpenAI chat models (o-series, gpt-5 family) reject `max_tokens`.
      max_completion_tokens: input.maxTokens ?? this.cfg.maxTokens ?? 1024,
      stream: true,
    })) as AsyncIterable<OpenAIStreamChunk>
    for await (const chunk of s) {
      const d = chunk.choices[0]?.delta?.content
      if (d) yield d
    }
  }
}
