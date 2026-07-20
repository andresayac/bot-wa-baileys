/**
 * GeminiProvider — native Google Gemini via `@google/generative-ai` (optional
 * peer dependency, loaded lazily). Gemini is not OpenAI-compatible at the
 * message-shape level (it uses `parts` and the `model` role), so it gets its
 * own provider rather than a preset.
 */

import type { AIProvider, GenerateInput, GenerateResult, AIConfig, AIMessage } from '../types.js'

export interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
}
export interface GeminiModelLike {
  generateContent(args: Record<string, unknown>): Promise<{
    response: { text(): string; usageMetadata?: GeminiUsage }
  }>
  generateContentStream?(args: Record<string, unknown>): Promise<{
    stream: AsyncIterable<{ text(): string }>
  }>
}
export interface GeminiLike {
  getGenerativeModel(cfg: { model: string }): GeminiModelLike
}

const DEFAULT_MODEL = 'gemini-2.0-flash'

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini'
  constructor(
    private client: GeminiLike,
    private cfg: AIConfig,
  ) {}

  private contents(messages: AIMessage[]): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
    return messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  }

  private buildArgs(input: GenerateInput): Record<string, unknown> {
    const args: Record<string, unknown> = {
      contents: this.contents(input.messages),
      generationConfig: { maxOutputTokens: input.maxTokens ?? this.cfg.maxTokens ?? 1024 },
    }
    if (input.system) args.systemInstruction = { text: input.system }
    return args
  }

  private model(input: GenerateInput): GeminiModelLike {
    return this.client.getGenerativeModel({ model: input.model ?? this.cfg.model ?? DEFAULT_MODEL })
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await this.model(input).generateContent(this.buildArgs(input))
    const usage = res.response.usageMetadata
    return {
      text: res.response.text(),
      model: input.model ?? this.cfg.model ?? DEFAULT_MODEL,
      usage: usage ? { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 } : undefined,
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const model = this.model(input)
    if (!model.generateContentStream) {
      const r = await this.generate(input)
      if (r.text) yield r.text
      return
    }
    const { stream } = await model.generateContentStream(this.buildArgs(input))
    for await (const chunk of stream) {
      const t = chunk.text()
      if (t) yield t
    }
  }
}
