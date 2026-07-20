import type { AIMessage } from '@bot-wa/bot-wa-baileys'

export interface ConvStore {
  getConversation(k: string): Promise<AIMessage[] | undefined>
  setConversation(k: string, m: AIMessage[]): Promise<void>
  clearConversation(k: string): Promise<void>
}

export class ContextManager {
  private max: number
  constructor(private store: ConvStore, opts: { maxMessages?: number } = {}) {
    this.max = opts.maxMessages ?? 20
  }
  async history(key: string): Promise<AIMessage[]> {
    return (await this.store.getConversation(key)) ?? []
  }
  async append(key: string, msg: AIMessage): Promise<void> {
    const h = await this.history(key)
    h.push(msg)
    const trimmed = h.length > this.max ? h.slice(h.length - this.max) : h
    await this.store.setConversation(key, trimmed)
  }
  async clear(key: string): Promise<void> {
    await this.store.clearConversation(key)
  }
}
