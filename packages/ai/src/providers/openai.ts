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
  choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
}
export interface OpenAIRequestOptions {
  signal?: AbortSignal
}
export interface OpenAILike {
  chat: {
    completions: {
      create(args: Record<string, unknown>, options?: OpenAIRequestOptions): Promise<OpenAIChatCompletion | AsyncIterable<OpenAIStreamChunk>>
    }
  }
}

export interface OpenAIProviderOptions {
  /** Provider display name (defaults to 'openai'; presets pass their own). */
  name?: string
  /**
   * Which field carries the output-token cap. Current OpenAI chat models
   * (o-series, gpt-5 family) reject `max_tokens` and need `max_completion_tokens`;
   * nearly every OpenAI-compatible clone wants plain `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
}

export class OpenAIProvider implements AIProvider {
  readonly name: string
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
  constructor(
    private client: OpenAILike,
    private cfg: AIConfig,
    opts: OpenAIProviderOptions = {},
  ) {
    this.name = opts.name ?? 'openai'
    this.maxTokensField = opts.maxTokensField ?? 'max_completion_tokens'
  }

  private messagesFor(input: GenerateInput): ChatMessage[] {
    return input.system ? [{ role: 'system', content: input.system }, ...input.messages] : [...input.messages]
  }
  private model(input: GenerateInput): string {
    const m = input.model ?? this.cfg.model
    if (!m) throw new Error('OpenAIProvider requiere `model` en la config (sin default).')
    return m
  }
  private baseArgs(input: GenerateInput): Record<string, unknown> {
    return {
      model: this.model(input),
      messages: this.messagesFor(input),
      [this.maxTokensField]: input.maxTokens ?? this.cfg.maxTokens ?? 1024,
    }
  }

  private reqOpts(input: GenerateInput): OpenAIRequestOptions | undefined {
    return input.signal ? { signal: input.signal } : undefined
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = (await this.client.chat.completions.create(this.baseArgs(input), this.reqOpts(input))) as OpenAIChatCompletion
    return {
      text: res.choices[0]?.message?.content ?? '',
      model: res.model,
      stopReason: res.choices[0]?.finish_reason,
      usage: res.usage ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens } : undefined,
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const s = (await this.client.chat.completions.create({
      ...this.baseArgs(input),
      stream: true,
    }, this.reqOpts(input))) as AsyncIterable<OpenAIStreamChunk>
    let stopReason: string | undefined
    for await (const chunk of s) {
      const d = chunk.choices[0]?.delta?.content
      if (d) yield d
      stopReason = chunk.choices[0]?.finish_reason ?? stopReason
    }
    input.onStreamEnd?.({ stopReason })
  }
}
