import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import type { AIMessage } from '@bot-wa/core'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { AIClient, AITimeoutError } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { aiPlugin } from '../src/plugin.js'
import type { AIPluginConfig } from '../src/plugin.js'
import type { AIProvider, GenerateInput } from '../src/types.js'

function memStore() {
  const m = new Map<string, AIMessage[]>()
  return {
    m,
    async getConversation(k: string) { return m.get(k) },
    async setConversation(k: string, v: AIMessage[]) { m.set(k, v) },
    async clearConversation(k: string) { m.delete(k) },
  }
}

/** A streaming provider that yields words with a small delay. */
class SlowStream implements AIProvider {
  readonly name = 'slow'
  readonly inputs: GenerateInput[] = []
  returned = false
  constructor(private words: string[], private delayMs = 3) {}
  async generate() { return { text: this.words.join(''), model: 'slow' } }
  async *stream(input: GenerateInput): AsyncIterable<string> {
    this.inputs.push(input)
    try {
      for (const w of this.words) { await new Promise((r) => setTimeout(r, this.delayMs)); yield w }
    } finally { this.returned = true }
  }
}

describe('AIClient.streamReplyInChat', () => {
  it('yields the provider stream and stores the turn when it completes', async () => {
    const store = memStore()
    const client = new AIClient(new SlowStream(['Hola', ' que', ' tal']), new ContextManager(store))
    const out: string[] = []
    for await (const t of client.streamReplyInChat('k', 'hey')) out.push(t)
    expect(out.join('')).toBe('Hola que tal')
    expect(store.m.get('k')).toEqual([
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'Hola que tal' },
    ])
  })

  it('stores the partial answer when the consumer stops early, and cancels the provider', async () => {
    const store = memStore()
    const provider = new SlowStream(['a', 'b', 'c', 'd'])
    const client = new AIClient(provider, new ContextManager(store))
    for await (const t of client.streamReplyInChat('k', 'q')) { if (t === 'b') break }
    expect(store.m.get('k')?.at(-1)).toEqual({ role: 'assistant', content: 'ab' })
    expect(provider.returned).toBe(true)
    expect(provider.inputs[0].signal?.aborted).toBe(true)
  })

  it('does not store anything when the provider fails', async () => {
    const store = memStore()
    const p = new SlowStream([])
    p.stream = async function* () { yield 'x'; throw new Error('down') }
    const client = new AIClient(p, new ContextManager(store))
    await expect((async () => { for await (const _ of client.streamReplyInChat('k', 'q')) { /* drain */ } })()).rejects.toThrow('down')
    expect(store.m.get('k')).toBeUndefined()
  })

  it('return() aborts the provider at once and does not store the chunk still in flight', async () => {
    const store = memStore()
    let signal: AbortSignal | undefined
    const provider: AIProvider = {
      name: 'hang',
      async generate() { return { text: '', model: 'h' } },
      async *stream(input) {
        signal = input.signal
        yield 'seen '
        // The next chunk only arrives much later (a thinking / silent model).
        await new Promise((r) => setTimeout(r, 300))
        yield 'unseen'
      },
    }
    const client = new AIClient(provider, new ContextManager(store))
    const it = client.streamReplyInChat('k', 'q')[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe('seen ')
    const pending = it.next()
    pending.catch(() => undefined)
    void it.return?.(undefined)
    expect(signal?.aborted).toBe(true)
    await vi.waitFor(() => expect(store.m.get('k')).toBeDefined(), { timeout: 200 })
    expect(store.m.get('k')?.at(-1)).toEqual({ role: 'assistant', content: 'seen ' })
  })

  it('keepPartial: false stores nothing when the consumer stops early', async () => {
    const store = memStore()
    const client = new AIClient(new SlowStream(['a', 'b', 'c']), new ContextManager(store))
    for await (const t of client.streamReplyInChat('k', 'q', { keepPartial: false })) { if (t === 'a') break }
    await new Promise((r) => setTimeout(r, 20))
    expect(store.m.get('k')).toBeUndefined()
  })

  it('a refusal yields refusalMessage instead and is not stored', async () => {
    const store = memStore()
    const mock = new MockAIProvider({ reply: '', stopReason: 'refusal' })
    const client = new AIClient(mock, new ContextManager(store), { refusalMessage: 'no puedo' })
    const out: string[] = []
    for await (const t of client.streamReplyInChat('k', 'q')) out.push(t)
    expect(out.join('')).toBe('no puedo')
    expect(store.m.get('k')).toBeUndefined()
  })

  it('times out when the provider goes idle longer than timeoutMs between chunks', async () => {
    const client = new AIClient(new SlowStream(['a', 'b'], 200), new ContextManager(memStore()), { timeoutMs: 30 })
    await expect((async () => { for await (const _ of client.streamReplyInChat('k', 'q')) { /* drain */ } })()).rejects.toBeInstanceOf(AITimeoutError)
  })
})

describe('aiPlugin with stream', () => {
  async function botWith(cfg: AIPluginConfig, provider: AIProvider, streaming: 'draft' | 'edit' | 'none' = 'edit') {
    const tb = await createTestBot({}, { provider: { streaming } })
    tb.bot.plug(aiPlugin({ __provider: provider, ...cfg }))
    return tb
  }

  it('stream: true renders the reply with ctx.stream (edits) and keeps context', async () => {
    const ai = new SlowStream(['Respuesta', ' en', ' vivo'])
    const { provider, chat, bot } = await botWith({ stream: { throttleMs: 0 } }, ai)
    await chat.send('hola')
    await vi.waitFor(() => expect(provider.edits.at(-1)?.content).toEqual({ kind: 'text', text: 'Respuesta en vivo' }))
    expect(provider.outbox.filter((o) => o.content.kind === 'text')).toHaveLength(1)
    await bot.stop()
  })

  it('stream on a draft provider uses drafts then one final message', async () => {
    const ai = new SlowStream(['Hola', ' humano'])
    const { provider, chat, bot } = await botWith({ stream: { throttleMs: 0, canStop: true } }, ai, 'draft')
    await chat.send('hola')
    await chat.expectReply('Hola humano')
    expect(provider.drafts.length).toBeGreaterThan(0)
    expect(provider.drafts[0].opts?.canStop).toBe(true)
    await bot.stop()
  })

  it('default (no stream option) keeps the one-shot reply', async () => {
    const mock = new MockAIProvider({ reply: 'una sola vez' })
    const streamSpy = vi.spyOn(mock, 'stream')
    const { chat, bot } = await botWith({}, mock)
    await chat.send('hola')
    await chat.expectReply('una sola vez')
    expect(streamSpy).not.toHaveBeenCalled()
    await bot.stop()
  })

  it('stream: false is the same as omitting it', async () => {
    const mock = new MockAIProvider({ reply: 'clasico' })
    const { chat, bot } = await botWith({ stream: false }, mock)
    await chat.send('hola')
    await chat.expectReply('clasico')
    await bot.stop()
  })

  it('a streamed refusal replies refusalMessage and keeps it out of the context', async () => {
    const mock = new MockAIProvider({ reply: '', stopReason: 'refusal' })
    const { chat, bot } = await botWith({ stream: { throttleMs: 0 }, refusalMessage: 'eso no' }, mock, 'none')
    await chat.send('hola')
    await chat.expectReply('eso no')
    await chat.send('otra')
    await vi.waitFor(() => expect(mock.calls).toHaveLength(2))
    expect(mock.calls[1].messages).toEqual([{ role: 'user', content: 'otra' }])
    await bot.stop()
  })

  it("onCancel: 'discard' + the user's stop keeps the unseen answer out of the context", async () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i} `)
    const ai = new SlowStream(words, 3)
    const { provider, chat, bot } = await botWith({ stream: { throttleMs: 0, canStop: true, onCancel: 'discard' } }, ai, 'draft')
    await chat.send('hola')
    await vi.waitFor(() => expect(provider.drafts.length).toBeGreaterThan(0))
    expect(provider.stopDraft()).toBe(true)
    await vi.waitFor(() => expect(ai.returned).toBe(true))
    expect(ai.inputs[0].signal?.aborted).toBe(true)
    expect(chat.replies()).toEqual([])
    await chat.send('otra')
    await vi.waitFor(() => expect(ai.inputs).toHaveLength(2))
    expect(ai.inputs[1].messages).toEqual([{ role: 'user', content: 'otra' }])
    await bot.stop()
  })

  it('an empty streamed answer replies errorMessage instead of silence', async () => {
    const ai = new SlowStream([])
    const { chat, bot } = await botWith({ stream: { throttleMs: 0 }, errorMessage: 'sin respuesta' }, ai, 'none')
    await chat.send('hola')
    await chat.expectReply('sin respuesta')
    await bot.stop()
  })

  it('a stream failure replies errorMessage', async () => {
    const ai = new SlowStream([])
    ai.stream = async function* () { throw new Error('boom') }
    const { chat, bot } = await botWith({ stream: true, errorMessage: 'sin servicio' }, ai)
    await chat.send('hola')
    await chat.expectReply('sin servicio')
    await bot.stop()
  })
})
