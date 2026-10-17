import type { AIProvider, GenerateInput, GenerateResult, AIConfig, AIChatMessage } from '../types.js'
import type { AIToolCall } from '../tools/types.js'

type ChatMessage = Record<string, unknown>

export interface OpenAIToolCall {
  id: string
  type?: string
  function: { name: string; arguments: string }
}
export interface OpenAIChoice {
  message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }
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
    const out: ChatMessage[] = input.system ? [{ role: 'system', content: input.system }] : []
    for (const m of input.messages) out.push(...toOpenAIMessages(m))
    return out
  }
  private model(input: GenerateInput): string {
    const m = input.model ?? this.cfg.model
    if (!m) throw new Error('OpenAIProvider requiere `model` en la config (sin default).')
    return m
  }
  private baseArgs(input: GenerateInput): Record<string, unknown> {
    const args: Record<string, unknown> = {
      model: this.model(input),
      messages: this.messagesFor(input),
      [this.maxTokensField]: input.maxTokens ?? this.cfg.maxTokens ?? 1024,
    }
    if (input.tools?.length) {
      args.tools = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    return args
  }

  private reqOpts(input: GenerateInput): OpenAIRequestOptions | undefined {
    return input.signal ? { signal: input.signal } : undefined
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = (await this.client.chat.completions.create(this.baseArgs(input), this.reqOpts(input))) as OpenAIChatCompletion
    const toolCalls: AIToolCall[] = (res.choices[0]?.message?.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === 'string')
      .map((c) => ({ id: c.id, name: c.function.name, args: parseArguments(c.function.arguments) }))
    return {
      text: res.choices[0]?.message?.content ?? '',
      model: res.model,
      stopReason: res.choices[0]?.finish_reason,
      usage: res.usage ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens } : undefined,
      ...(toolCalls.length ? { toolCalls } : {}),
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    // Streaming is text-only: tool definitions are not sent.
    const { tools: _tools, ...textOnly } = input
    const s = (await this.client.chat.completions.create({
      ...this.baseArgs(textOnly),
      stream: true,
    }, this.reqOpts(input))) as AsyncIterable<OpenAIStreamChunk>
    for await (const chunk of s) {
      const d = chunk.choices[0]?.delta?.content
      if (d) yield d
    }
  }
}

/** Parse a function-call `arguments` JSON string; an unparseable payload is passed raw (validation reports it). */
function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Map a provider-neutral turn to OpenAI chat-completions messages (a tool turn → one message per result). */
function toOpenAIMessages(m: AIChatMessage): ChatMessage[] {
  if (m.role === 'tool') {
    return m.results.map((r) => ({ role: 'tool', tool_call_id: r.callId, content: r.content }))
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return [{
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    }]
  }
  return [{ role: m.role, content: m.content }]
}
