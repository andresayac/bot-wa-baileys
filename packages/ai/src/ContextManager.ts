import type { AIMessage } from '@botmesh/core'

export interface ConvStore {
  getConversation(k: string): Promise<AIMessage[] | undefined>
  setConversation(k: string, m: AIMessage[]): Promise<void>
  clearConversation(k: string): Promise<void>
}

/**
 * Per-chat conversation window for the AI, stored in the bot's `IStore`.
 *
 * The history it returns is always one the providers accept: it starts with a
 * `user` turn (Anthropic and Gemini reject a conversation that opens with the
 * assistant, which an odd `maxMessages` used to produce when trimming) and has
 * no blank turns (Anthropic rejects an empty assistant message, so one stored
 * empty answer used to break every later turn of the chat).
 */
export class ContextManager {
  private max: number
  constructor(private store: ConvStore, opts: { maxMessages?: number } = {}) {
    this.max = opts.maxMessages ?? 20
  }
  async history(key: string): Promise<AIMessage[]> {
    return sanitize((await this.store.getConversation(key)) ?? [])
  }
  async append(key: string, msg: AIMessage): Promise<void> {
    await this.appendMany(key, [msg])
  }
  /** Append several messages in ONE read+write (avoids a store write per message). */
  async appendMany(key: string, msgs: AIMessage[]): Promise<void> {
    if (msgs.length === 0) return
    const h = [...(await this.history(key)), ...msgs]
    const trimmed = h.length > this.max ? h.slice(h.length - this.max) : h
    await this.store.setConversation(key, sanitize(trimmed))
  }
  async clear(key: string): Promise<void> {
    await this.store.clearConversation(key)
  }
}

/** Drop blank turns, then any assistant turns before the first user turn. */
function sanitize(messages: readonly AIMessage[]): AIMessage[] {
  const kept = messages.filter((m) => typeof m?.content === 'string' && m.content.trim().length > 0)
  const first = kept.findIndex((m) => m.role === 'user')
  return first === -1 ? [] : kept.slice(first)
}
