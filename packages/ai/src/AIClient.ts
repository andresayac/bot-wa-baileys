import type { AIMessage } from '@bot-wa/bot-wa-baileys'
import type { AIProvider, GenerateInput, GenerateResult, Effort } from './types.js'
import type { ContextManager } from './ContextManager.js'

export interface AIClientOptions {
  persona?: string
  model?: string
  maxTokens?: number
  effort?: Effort
  refusalMessage?: string
}

export class AIClient {
  constructor(
    private provider: AIProvider,
    private ctx: ContextManager,
    private opts: AIClientOptions = {},
  ) {}

  private base(messages: AIMessage[]): GenerateInput {
    return {
      system: this.opts.persona,
      messages,
      model: this.opts.model,
      maxTokens: this.opts.maxTokens,
      effort: this.opts.effort,
    }
  }

  async ask(prompt: string): Promise<string> {
    const r = await this.provider.generate(this.base([{ role: 'user', content: prompt }]))
    return r.stopReason === 'refusal' ? (this.opts.refusalMessage ?? 'No puedo ayudar con eso.') : r.text
  }

  async generate(input: Partial<GenerateInput> & { messages: AIMessage[] }): Promise<GenerateResult> {
    return this.provider.generate({ ...this.base(input.messages), ...input })
  }

  stream(input: Partial<GenerateInput> & { messages: AIMessage[] }): AsyncIterable<string> {
    return this.provider.stream({ ...this.base(input.messages), ...input })
  }

  async replyInChat(chatKey: string, userText: string): Promise<string> {
    const history = await this.ctx.history(chatKey)
    const messages: AIMessage[] = [...history, { role: 'user', content: userText }]
    const r = await this.provider.generate(this.base(messages))
    if (r.stopReason === 'refusal') {
      return this.opts.refusalMessage ?? 'No puedo ayudar con eso.'
    }
    await this.ctx.append(chatKey, { role: 'user', content: userText })
    await this.ctx.append(chatKey, { role: 'assistant', content: r.text })
    return r.text
  }
}
