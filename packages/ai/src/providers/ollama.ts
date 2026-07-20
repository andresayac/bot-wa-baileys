import type { AIProvider, GenerateInput, GenerateResult, AIConfig } from '../types.js'

interface OllamaChatMessage {
  role: string
  content: string
}
interface OllamaChatResponse {
  message?: { content?: string }
  model?: string
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama'
  private base: string
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
    return input.system ? [{ role: 'system', content: input.system }, ...input.messages] : [...input.messages]
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await this.fetchImpl(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model(input), messages: this.messagesFor(input), stream: false }),
      signal: input.signal,
    })
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}`)
    const data = (await res.json()) as OllamaChatResponse
    return { text: data.message?.content ?? '', model: data.model ?? this.model(input) }
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
