import type { AIMessage } from '@bot-wa/core'

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
    await this.appendMany(key, [msg])
  }
  /** Append several messages in ONE read+write (avoids a store write per message). */
  async appendMany(key: string, msgs: AIMessage[]): Promise<void> {
    if (msgs.length === 0) return
    const h = [...(await this.history(key)), ...msgs]
    const trimmed = h.length > this.max ? h.slice(h.length - this.max) : h
    await this.store.setConversation(key, trimmed)
  }
  async clear(key: string): Promise<void> {
    await this.store.clearConversation(key)
  }
}
