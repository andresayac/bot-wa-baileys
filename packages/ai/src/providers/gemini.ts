/**
 * GeminiProvider — native Google Gemini via `@google/generative-ai` (optional
 * peer dependency, loaded lazily). Gemini is not OpenAI-compatible at the
 * message-shape level (it uses `parts` and the `model` role), so it gets its
 * own provider rather than a preset.
 */

import type { AIProvider, GenerateInput, GenerateResult, AIConfig, AIChatMessage } from '../types.js'
import type { AIToolCall, JSONSchema } from '../tools/types.js'

export interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
}
export interface GeminiRequestOptions {
  signal?: AbortSignal
}
export interface GeminiFunctionCall {
  name: string
  args?: unknown
}
export interface GeminiPart {
  text?: string
  functionCall?: GeminiFunctionCall
  functionResponse?: { name: string; response: Record<string, unknown> }
}
export interface GeminiResponse {
  text(): string
  usageMetadata?: GeminiUsage
  functionCalls?(): GeminiFunctionCall[] | undefined
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
}
export interface GeminiModelLike {
  generateContent(args: Record<string, unknown>, requestOptions?: GeminiRequestOptions): Promise<{
    response: GeminiResponse
  }>
  generateContentStream?(args: Record<string, unknown>, requestOptions?: GeminiRequestOptions): Promise<{
    stream: AsyncIterable<{ text(): string }>
  }>
}
export interface GeminiLike {
  getGenerativeModel(cfg: { model: string }): GeminiModelLike
}

type GeminiContent = { role: 'user' | 'model' | 'function'; parts: GeminiPart[] }

const DEFAULT_MODEL = 'gemini-2.0-flash'

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini'
  private callSeq = 0
  constructor(
    private client: GeminiLike,
    private cfg: AIConfig,
  ) {}

  private contents(messages: AIChatMessage[]): GeminiContent[] {
    return messages.map(toGeminiContent)
  }

  private buildArgs(input: GenerateInput, withTools = true): Record<string, unknown> {
    const args: Record<string, unknown> = {
      contents: this.contents(input.messages),
      generationConfig: { maxOutputTokens: input.maxTokens ?? this.cfg.maxTokens ?? 1024 },
    }
    if (input.system) args.systemInstruction = { text: input.system }
    if (withTools && input.tools?.length) {
      args.tools = [{
        functionDeclarations: input.tools.map((t) => {
          const parameters = toGeminiSchema(t.parameters)
          const props = parameters.properties
          const hasProps = typeof props === 'object' && props !== null && Object.keys(props).length > 0
          // Gemini rejects an OBJECT schema with no properties: omit parameters for no-arg tools.
          return hasProps ? { name: t.name, description: t.description, parameters } : { name: t.name, description: t.description }
        }),
      }]
    }
    return args
  }

  private model(input: GenerateInput): GeminiModelLike {
    return this.client.getGenerativeModel({ model: input.model ?? this.cfg.model ?? DEFAULT_MODEL })
  }

  private reqOpts(input: GenerateInput): GeminiRequestOptions | undefined {
    return input.signal ? { signal: input.signal } : undefined
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await this.model(input).generateContent(this.buildArgs(input), this.reqOpts(input))
    const usage = res.response.usageMetadata
    const calls = res.response.functionCalls?.()
      ?? (res.response.candidates?.[0]?.content?.parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall] : []))
    // Gemini does not id function calls; synthesize ids so results can be matched.
    const toolCalls: AIToolCall[] = calls.map((c) => ({ id: `gemini_call_${++this.callSeq}`, name: c.name, args: c.args ?? {} }))
    let text = ''
    try { text = res.response.text() } catch { text = '' }
    const finish = res.response.candidates?.[0]?.finishReason
    return {
      text,
      model: input.model ?? this.cfg.model ?? DEFAULT_MODEL,
      usage: usage ? { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 } : undefined,
      ...(finish ? { stopReason: finish } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const model = this.model(input)
    if (!model.generateContentStream) {
      const r = await this.generate(input)
      if (r.text) yield r.text
      return
    }
    const { stream } = await model.generateContentStream(this.buildArgs(input, false), this.reqOpts(input))
    for await (const chunk of stream) {
      const t = chunk.text()
      if (t) yield t
    }
  }
}

function toGeminiContent(m: AIChatMessage): GeminiContent {
  if (m.role === 'tool') {
    return {
      role: 'function',
      parts: m.results.map((r) => ({
        functionResponse: { name: r.name, response: r.isError ? { error: r.content } : { result: r.content } },
      })),
    }
  }
  if (m.role === 'assistant') {
    const parts: GeminiPart[] = []
    if (m.content || !m.toolCalls?.length) parts.push({ text: m.content })
    for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } })
    return { role: 'model', parts }
  }
  return { role: 'user', parts: [{ text: m.content }] }
}

/** Gemini accepts an OpenAPI subset of JSON Schema: drop the keywords it rejects. */
const GEMINI_UNSUPPORTED = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties', 'default', 'examples', 'const'])

export function toGeminiSchema(schema: JSONSchema): JSONSchema {
  const out: JSONSchema = {}
  for (const [k, v] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, pv && typeof pv === 'object' ? toGeminiSchema(pv as JSONSchema) : pv]),
      )
    } else if (k === 'items' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.items = toGeminiSchema(v as JSONSchema)
    } else {
      out[k] = v
    }
  }
  return out
}
