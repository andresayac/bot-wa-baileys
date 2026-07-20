import type { AIProvider, GenerateInput, GenerateResult } from './types.js'

export interface MockOptions { reply?: string | ((input: GenerateInput) => string); model?: string }

export class MockAIProvider implements AIProvider {
  readonly name = 'mock'
  readonly calls: GenerateInput[] = []
  constructor(private opts: MockOptions = {}) {}

  private textFor(input: GenerateInput): string {
    const r = this.opts.reply ?? 'mock reply'
    return typeof r === 'function' ? r(input) : r
  }
  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.calls.push(input)
    return { text: this.textFor(input), model: this.opts.model ?? 'mock', usage: { input: 0, output: 0 } }
  }
  async *stream(input: GenerateInput): AsyncIterable<string> {
    this.calls.push(input)
    for (const ch of this.textFor(input)) yield ch
  }
}
