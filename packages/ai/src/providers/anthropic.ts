import type { AIProvider, GenerateInput, GenerateResult, AIConfig, AIChatMessage } from '../types.js'
import type { AIToolCall } from '../tools/types.js'
import { anthropicModelSupport, assertThinking } from './anthropicModels.js'

export interface AnthropicContentBlock {
  type: string
  text?: string
  /** `tool_use` blocks. */
  id?: string
  name?: string
  input?: unknown
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
  /** `message_start`: the message being streamed (its `usage.input_tokens`). */
  message?: { usage?: Partial<AnthropicUsage> }
  /** `message_delta`: cumulative usage (`output_tokens`). */
  usage?: Partial<AnthropicUsage>
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

/** API minimum of `thinking.budget_tokens`. */
const MIN_BUDGET_TOKENS = 1024

/** Optional request parameters a model may reject with a 400 (dropped once, then remembered). */
type Droppable = 'thinking' | 'effort'

/** The droppable parameters a 400 error message names (empty: not a parameter-support error). */
function rejectedParams(err: unknown, sent: ReadonlySet<Droppable>): Droppable[] {
  if (typeof err !== 'object' || err === null) return []
  if ((err as { status?: unknown }).status !== 400) return []
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '')
  // A complaint about the replayed history (e.g. `messages.1.content.0: ... thinking block`)
  // is not about the request parameters: dropping them would not fix it.
  if (/messages\.\d/.test(message)) return []
  const out: Droppable[] = []
  if (sent.has('thinking') && /thinking/i.test(message)) out.push('thinking')
  if (sent.has('effort') && /effort|output_config/i.test(message)) out.push('effort')
  return out
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'
  /** Per model id: parameters the API rejected, so later calls do not send them again. */
  private readonly rejected = new Map<string, Set<Droppable>>()

  constructor(
    private client: AnthropicLike,
    private cfg: AIConfig,
  ) {
    assertThinking(cfg.thinking)
  }

  private buildArgs(input: GenerateInput): { args: Record<string, unknown>; sent: Set<Droppable> } {
    const model = input.model ?? this.cfg.model ?? DEFAULT_MODEL
    const support = anthropicModelSupport(model)
    const skip = this.rejected.get(model)
    const sent = new Set<Droppable>()
    let maxTokens = input.maxTokens ?? input.defaultMaxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS
    const args: Record<string, unknown> = {
      model,
      messages: input.messages.map(toAnthropicMessage),
    }
    const thinking = this.cfg.thinking ?? 'auto'
    if (!skip?.has('thinking') && thinking !== 'off') {
      if (thinking === 'adaptive' || support.adaptiveThinking) {
        args.thinking = { type: 'adaptive' }
        sent.add('thinking')
      } else if (typeof thinking === 'object') {
        const budget = Math.max(MIN_BUDGET_TOKENS, thinking.budgetTokens)
        // budget_tokens must stay below max_tokens; keep the answer's own budget on top.
        if (maxTokens <= budget) maxTokens = budget + maxTokens
        args.thinking = { type: 'enabled', budget_tokens: budget }
        sent.add('thinking')
      }
    }
    args.max_tokens = maxTokens
    if (input.system) args.system = input.system
    const effort = input.effort ?? this.cfg.effort
    if (effort && support.effort && !skip?.has('effort')) {
      args.output_config = { effort }
      sent.add('effort')
    }
    if (input.tools?.length) {
      args.tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }
    return { args, sent }
  }

  /** Remember the parameters `err` says the model rejects; true when a retry without them makes sense. */
  private learn(err: unknown, args: Record<string, unknown>, sent: ReadonlySet<Droppable>): boolean {
    const params = rejectedParams(err, sent)
    if (!params.length) return false
    const model = String(args.model)
    const set = this.rejected.get(model) ?? new Set<Droppable>()
    for (const p of params) set.add(p)
    this.rejected.set(model, set)
    return true
  }

  private reqOpts(input: GenerateInput): AnthropicRequestOptions | undefined {
    return input.signal ? { signal: input.signal } : undefined
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let { args, sent } = this.buildArgs(input)
    let res: AnthropicMessage
    try {
      res = await this.client.messages.create(args, this.reqOpts(input))
    } catch (err) {
      // An older model (e.g. claude-haiku-4-5) rejecting adaptive thinking / effort: retry once without it.
      if (!this.learn(err, args, sent)) throw err
      ;({ args, sent } = this.buildArgs(input))
      res = await this.client.messages.create(args, this.reqOpts(input))
    }
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    const toolCalls: AIToolCall[] = res.content
      .filter((b) => b.type === 'tool_use' && typeof b.name === 'string')
      .map((b, i) => ({ id: b.id ?? `toolu_${i}`, name: b.name as string, args: b.input ?? {} }))
    return {
      text,
      model: res.model,
      stopReason: res.stop_reason,
      usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : undefined,
      // Replay the full content (thinking + tool_use blocks) verbatim in the next step,
      // as the Messages API requires when tool use is combined with thinking.
      ...(toolCalls.length ? { toolCalls, providerData: res.content } : {}),
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const streamFn = this.client.messages.stream
    if (!streamFn) {
      const r = await this.generate(input)
      if (r.text) yield r.text
      input.onStreamEnd?.({ stopReason: r.stopReason, ...(r.usage ? { usage: r.usage } : {}) })
      return
    }
    let stopReason: string | undefined
    let usage: { input: number; output: number } | undefined
    for (let attempt = 0; ; attempt++) {
      const { args, sent } = this.buildArgs(input)
      let yielded = false
      try {
        const s = streamFn.call(this.client.messages, args, this.reqOpts(input))
        for await (const event of s) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            yielded = true
            yield event.delta.text
          } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
            if (typeof event.usage?.output_tokens === 'number') usage = { input: usage?.input ?? 0, output: event.usage.output_tokens }
          } else if (event.type === 'message_start' && typeof event.message?.usage?.input_tokens === 'number') {
            usage = { input: event.message.usage.input_tokens, output: usage?.output ?? 0 }
          }
        }
        break
      } catch (err) {
        // Same fallback as generate(), only while nothing reached the caller yet.
        if (attempt > 0 || yielded || !this.learn(err, args, sent)) throw err
      }
    }
    input.onStreamEnd?.({ stopReason, ...(usage ? { usage } : {}) })
  }
}

/** Map a provider-neutral turn to the Anthropic Messages shape. Plain text turns pass through unchanged. */
function toAnthropicMessage(m: AIChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.callId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    }
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const content = Array.isArray(m.providerData)
      ? m.providerData
      : [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })),
        ]
    return { role: 'assistant', content }
  }
  return { role: m.role, content: m.content }
}
