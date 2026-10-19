import type { AIProvider, GenerateInput, GenerateResult, AIConfig, AIChatMessage } from '../types.js'
import type { AIToolCall } from '../tools/types.js'

type OllamaChatMessage = Record<string, unknown>
interface OllamaToolCall {
  id?: string
  function?: { name?: string; arguments?: unknown }
}
interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] }
  model?: string
  done_reason?: string
  /** Set instead of `message` when the request (or the model, mid-stream) failed. */
  error?: string
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama'
  private base: string
  private callSeq = 0
  constructor(
    private cfg: AIConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = (cfg.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')
  }

  private model(input: GenerateInput): string {
    const m = input.model ?? this.cfg.model
    if (!m) throw new Error('OllamaProvider requiere `model` en la config (sin default).')
    return m
  }
  private messagesFor(input: GenerateInput): OllamaChatMessage[] {
    const out: OllamaChatMessage[] = input.system ? [{ role: 'system', content: input.system }] : []
    for (const m of input.messages) out.push(...toOllamaMessages(m))
    return out
  }

  /** Request body shared by `generate` and `stream`. */
  private body(input: GenerateInput, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.model(input), messages: this.messagesFor(input), stream }
    // Ollama has no default cap; only send one when the caller set it. `defaultMaxTokens`
    // (a soft default, e.g. memory extraction's 300) is ignored on purpose: thinking
    // models spend num_predict on reasoning and would be cut off.
    const maxTokens = input.maxTokens ?? this.cfg.maxTokens
    if (maxTokens !== undefined) body.options = { num_predict: maxTokens }
    // Streaming is text-only (like the other providers): tool definitions are not sent.
    if (!stream && input.tools?.length) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    return body
  }

  private async post(input: GenerateInput, stream: boolean): Promise<Response> {
    const res = await this.fetchImpl(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.body(input, stream)),
      signal: input.signal,
    })
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}${await errorDetail(res)}`)
    return res
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await this.post(input, false)
    const data = (await res.json()) as OllamaChatResponse
    if (data.error) throw new Error(`Ollama: ${data.error}`)
    // Ollama does not id its tool calls; synthesize stable-per-provider ids.
    const toolCalls: AIToolCall[] = (data.message?.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === 'string')
      .map((c) => ({ id: c.id ?? `call_${++this.callSeq}`, name: c.function?.name as string, args: parseArgs(c.function?.arguments) }))
    return {
      text: data.message?.content ?? '',
      model: data.model ?? this.model(input),
      ...(data.done_reason ? { stopReason: data.done_reason } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    }
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    const res = await this.post(input, true)
    if (!res.body) throw new Error('Ollama respondió sin cuerpo')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let stopReason: string | undefined
    // One NDJSON line → its text; an `{"error"}` line (the model crashed mid-stream) rejects.
    const parse = (line: string): string | undefined => {
      if (!line.trim()) return undefined
      const obj = JSON.parse(line) as OllamaChatResponse
      if (obj.error) throw new Error(`Ollama: ${obj.error}`)
      if (obj.done_reason) stopReason = obj.done_reason
      return obj.message?.content || undefined
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const t = parse(line)
          if (t) yield t
        }
      }
      // The last line may come without a trailing newline.
      const t = parse(buf + decoder.decode())
      if (t) yield t
    } finally {
      // Stopped early (or failed): release the connection.
      reader.cancel().catch(() => undefined)
    }
    input.onStreamEnd?.({ stopReason })
  }
}

/** `: <server error>` from an error response body (Ollama answers `{"error": "..."}`), or ''. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const raw = (await res.text()).trim()
    if (!raw) return ''
    let msg = raw
    try {
      const parsed = JSON.parse(raw) as { error?: unknown }
      if (typeof parsed.error === 'string') msg = parsed.error
    } catch { /* not JSON: keep the raw text */ }
    return `: ${msg.slice(0, 300)}`
  } catch {
    return ''
  }
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Map a provider-neutral turn to Ollama `/api/chat` messages (a tool turn → one message per result). */
function toOllamaMessages(m: AIChatMessage): OllamaChatMessage[] {
  if (m.role === 'tool') {
    return m.results.map((r) => ({ role: 'tool', content: r.content, tool_name: r.name }))
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return [{
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })),
    }]
  }
  return [{ role: m.role, content: m.content }]
}
