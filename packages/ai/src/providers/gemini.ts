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
  /** Opaque signature of a thinking model's reasoning; must be replayed with its part. */
  thoughtSignature?: string
  thought?: boolean
}
export interface GeminiResponse {
  text(): string
  usageMetadata?: GeminiUsage
  functionCalls?(): GeminiFunctionCall[] | undefined
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  /** Set when the prompt itself was blocked (then there are no candidates). */
  promptFeedback?: { blockReason?: string }
}
export interface GeminiModelLike {
  generateContent(args: Record<string, unknown>, requestOptions?: GeminiRequestOptions): Promise<{
    response: GeminiResponse
  }>
  generateContentStream?(args: Record<string, unknown>, requestOptions?: GeminiRequestOptions): Promise<{
    stream: AsyncIterable<Pick<GeminiResponse, 'text' | 'candidates' | 'promptFeedback'>>
  }>
}
export interface GeminiLike {
  getGenerativeModel(cfg: { model: string }): GeminiModelLike
}

type GeminiContent = { role: 'user' | 'model' | 'function'; parts: GeminiPart[] }

const DEFAULT_MODEL = 'gemini-2.0-flash'

/**
 * Finish / block reasons meaning the answer was withheld by Gemini's safety
 * filters. They are reported as `stopReason: 'refusal'` (the autoreply then
 * answers `refusalMessage`) instead of the SDK's `text()` exception.
 */
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'])

/** The response (or stream chunk) was blocked by the safety filters. */
function blocked(r: Pick<GeminiResponse, 'candidates' | 'promptFeedback'>): boolean {
  const reason = r.candidates?.[0]?.finishReason
  return (reason !== undefined && BLOCKED.has(reason)) || !!r.promptFeedback?.blockReason
}

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
      generationConfig: { maxOutputTokens: input.maxTokens ?? input.defaultMaxTokens ?? this.cfg.maxTokens ?? 1024 },
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
    const parts = res.response.candidates?.[0]?.content?.parts
    const calls = res.response.functionCalls?.()
      ?? (parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall] : []))
    // Gemini does not id function calls; synthesize ids so results can be matched.
    const toolCalls: AIToolCall[] = calls.map((c) => ({ id: `gemini_call_${++this.callSeq}`, name: c.name, args: c.args ?? {} }))
    let text = ''
    let refused = false
    try {
      text = res.response.text()
    } catch (err) {
      // The SDK throws from text() for blocked responses (SAFETY, RECITATION, a blocked
      // prompt...): that is a refusal, not a failure. Only a pure function-call turn may
      // have no text; anything else stays an error.
      if (!toolCalls.length && blocked(res.response)) refused = true
      else if (!toolCalls.length) throw err
    }
    const finish = refused ? 'refusal' : res.response.candidates?.[0]?.finishReason
    return {
      text,
      model: input.model ?? this.cfg.model ?? DEFAULT_MODEL,
      usage: usage ? { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 } : undefined,
      ...(finish ? { stopReason: finish } : {}),
      // Raw parts carry the thoughtSignature that thinking models (2.5 / 3) require
      // to be sent back unchanged in the next step of a function-calling loop.
      ...(toolCalls.length ? { toolCalls, ...(parts?.length ? { providerData: parts } : {}) } : {}),
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const model = this.model(input)
    if (!model.generateContentStream) {
      const r = await this.generate(input)
      if (r.text) yield r.text
      input.onStreamEnd?.({ stopReason: r.stopReason })
      return
    }
    const { stream } = await model.generateContentStream(this.buildArgs(input, false), this.reqOpts(input))
    let stopReason: string | undefined
    for await (const chunk of stream) {
      if (blocked(chunk)) {
        // The rest of the answer was withheld: report a refusal (the SDK's text() would throw).
        stopReason = 'refusal'
        break
      }
      stopReason = chunk.candidates?.[0]?.finishReason ?? stopReason
      const t = chunk.text()
      if (t) yield t
    }
    input.onStreamEnd?.({ stopReason })
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
    if (Array.isArray(m.providerData) && m.providerData.length) return { role: 'model', parts: m.providerData as GeminiPart[] }
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
