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

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const body: Record<string, unknown> = { model: this.model(input), messages: this.messagesFor(input), stream: false }
    if (input.tools?.length) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    const res = await this.fetchImpl(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: input.signal,
    })
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}`)
    const data = (await res.json()) as OllamaChatResponse
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
    const res = await this.fetchImpl(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model(input), messages: this.messagesFor(input), stream: true }),
      signal: input.signal,
    })
    if (!res.ok || !res.body) throw new Error(`Ollama respondió ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const obj = JSON.parse(line) as OllamaChatResponse
        if (obj.message?.content) yield obj.message.content
      }
    }
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
