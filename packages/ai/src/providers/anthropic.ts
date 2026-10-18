import type { AIProvider, GenerateInput, GenerateResult, AIConfig } from '../types.js'

export interface AnthropicContentBlock {
  type: string
  text?: string
}
export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}
export interface AnthropicMessage {
  content: AnthropicContentBlock[]
  stop_reason?: string
  model: string
  usage?: AnthropicUsage
}
export interface AnthropicStreamEvent {
  type?: string
  delta?: { type?: string; text?: string; stop_reason?: string | null }
}
export interface AnthropicRequestOptions {
  signal?: AbortSignal
}
export interface AnthropicLike {
  messages: {
    create(args: Record<string, unknown>, options?: AnthropicRequestOptions): Promise<AnthropicMessage>
    stream?(args: Record<string, unknown>, options?: AnthropicRequestOptions): AsyncIterable<AnthropicStreamEvent> & { getFinalMessage?: () => Promise<unknown> }
  }
}

const DEFAULT_MODEL = 'claude-opus-4-8'
// Adaptive thinking shares this budget with the visible reply; 1024 risks
// truncated/empty replies once reasoning tokens are spent, so default higher.
const DEFAULT_MAX_TOKENS = 4096

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'
  constructor(
    private client: AnthropicLike,
    private cfg: AIConfig,
  ) {}

  private buildArgs(input: GenerateInput): Record<string, unknown> {
    const args: Record<string, unknown> = {
      model: input.model ?? this.cfg.model ?? DEFAULT_MODEL,
      max_tokens: input.maxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: input.messages,
      thinking: { type: 'adaptive' },
    }
    if (input.system) args.system = input.system
    const effort = input.effort ?? this.cfg.effort
    if (effort) args.output_config = { effort }
    return args
  }

  private reqOpts(input: GenerateInput): AnthropicRequestOptions | undefined {
    return input.signal ? { signal: input.signal } : undefined
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await this.client.messages.create(this.buildArgs(input), this.reqOpts(input))
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return {
      text,
      model: res.model,
      stopReason: res.stop_reason,
      usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : undefined,
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    if (!this.client.messages.stream) {
      const r = await this.generate(input)
      if (r.text) yield r.text
      input.onStreamEnd?.({ stopReason: r.stopReason })
      return
    }
    const s = this.client.messages.stream(this.buildArgs(input), this.reqOpts(input))
    let stopReason: string | undefined
    for await (const event of s) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        yield event.delta.text
      } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason
      }
    }
    input.onStreamEnd?.({ stopReason })
  }
}
