import type { AIProvider, GenerateInput, GenerateResult } from './types.js'

/**
 * A scripted model turn: text and/or tool calls. Returned by a `reply`
 * function to simulate native tool calling in tests.
 *
 * @example
 * ```ts
 * new MockAIProvider({
 *   reply: (input) => input.messages.at(-1)?.role === 'tool'
 *     ? 'Listo'
 *     : { toolCalls: [{ name: 'buscar', args: { q: 'pan' } }] },
 * })
 * ```
 */
export interface MockTurn {
  text?: string
  toolCalls?: Array<{ id?: string; name: string; args?: unknown }>
  stopReason?: string
}

export interface MockOptions {
  reply?: string | MockTurn | ((input: GenerateInput) => string | MockTurn)
  model?: string
  /** Default stop reason reported by `generate()` and by `stream()` (through `onStreamEnd`), e.g. `'refusal'`. A turn's own `stopReason` wins. */
  stopReason?: string
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock'
  readonly calls: GenerateInput[] = []
  private seq = 0
  constructor(private opts: MockOptions = {}) {}

  private turnFor(input: GenerateInput): MockTurn {
    const r = this.opts.reply ?? 'mock reply'
    const v = typeof r === 'function' ? r(input) : r
    return typeof v === 'string' ? { text: v } : v
  }
  async generate(input: GenerateInput): Promise<GenerateResult> {
    // Snapshot messages: the tool loop keeps appending to the array it passes.
    this.calls.push({ ...input, messages: [...input.messages] })
    const turn = this.turnFor(input)
    const toolCalls = (turn.toolCalls ?? []).map((c) => ({ id: c.id ?? `mock_call_${++this.seq}`, name: c.name, args: c.args ?? {} }))
    const stopReason = turn.stopReason ?? this.opts.stopReason ?? (toolCalls.length ? 'tool_use' : undefined)
    return {
      text: turn.text ?? '',
      model: this.opts.model ?? 'mock',
      usage: { input: 0, output: 0 },
      ...(stopReason ? { stopReason } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    }
  }
  async *stream(input: GenerateInput): AsyncIterable<string> {
    this.calls.push({ ...input, messages: [...input.messages] })
    const turn = this.turnFor(input)
    for (const ch of turn.text ?? '') yield ch
    input.onStreamEnd?.({ stopReason: turn.stopReason ?? this.opts.stopReason })
  }
}
