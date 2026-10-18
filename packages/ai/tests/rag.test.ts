import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import { MemoryStore } from '@bot-wa/core'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { AIClient } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { aiPlugin } from '../src/plugin.js'
import { citedChunks, formatSources, ragContextBlock, toRagConfig, type AIRetrievedChunk, type AIRetriever } from '../src/rag.js'

const PASSAGES: AIRetrievedChunk[] = [
  { text: 'Los envíos tardan 3 días.', source: 'faq.md', citation: 'faq.md › Envíos', score: 0.9 },
  { text: 'Aceptamos tarjeta y PSE.', source: 'faq.md', citation: 'faq.md › Pagos', score: 0.4 },
]

function fakeRetriever(hits: AIRetrievedChunk[] = PASSAGES) {
  const queries: { query: string; options: unknown }[] = []
  let warmed = 0
  const retriever: AIRetriever & { queries: typeof queries; warmed: () => number } = {
    queries,
    warmed: () => warmed,
    async retrieve(query, options) { queries.push({ query, options }); return hits },
    async warmup() { warmed++ },
  }
  return retriever
}

describe('rag helpers', () => {
  it('ragContextBlock numbers passages with their citation', () => {
    const block = ragContextBlock(PASSAGES, 'INSTR')
    expect(block).toBe('## Reference context\nINSTR\n\n[1] (faq.md › Envíos)\nLos envíos tardan 3 días.\n\n[2] (faq.md › Pagos)\nAceptamos tarjeta y PSE.')
  })

  it('citedChunks keeps the [n] the answer used, or all when none', () => {
    expect(citedChunks('Tardan 3 días [1].', PASSAGES)).toEqual([PASSAGES[0]])
    expect(citedChunks('Ver [2] y [1] y [9]', PASSAGES)).toEqual(PASSAGES)
    expect(citedChunks('sin citas', PASSAGES)).toEqual(PASSAGES)
    expect(formatSources([PASSAGES[0]!, PASSAGES[0]!, { text: 'x', source: 'y.txt' }])).toBe('Fuentes: faq.md › Envíos, y.txt')
  })

  it('toRagConfig accepts a retriever or { retriever }, rejects garbage', () => {
    const r = fakeRetriever()
    expect(toRagConfig(r)).toEqual({ retriever: r })
    expect(toRagConfig({ retriever: r, topK: 2 })).toEqual({ retriever: r, topK: 2 })
    expect(toRagConfig(undefined)).toBeUndefined()
    expect(() => toRagConfig({} as AIRetriever)).toThrow(TypeError)
  })
})

describe('AIClient + RAG', () => {
  it('injects retrieved passages into the system prompt and returns citations', async () => {
    const mock = new MockAIProvider({ reply: 'Tardan 3 días [1].' })
    const retriever = fakeRetriever()
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { persona: 'ACME', rag: { retriever, topK: 2, minScore: 0.1 } })
    const r = await ai.replyInChatDetailed('c', '¿cuánto tarda el envío?')
    expect(retriever.queries).toEqual([{ query: '¿cuánto tarda el envío?', options: { topK: 2, minScore: 0.1, signal: expect.any(AbortSignal) } }])
    const sys = mock.calls[0]!.system!
    expect(sys.startsWith('ACME\n\n## Reference context')).toBe(true)
    expect(sys).toContain('[1] (faq.md › Envíos)\nLos envíos tardan 3 días.')
    expect(r).toMatchObject({ text: 'Tardan 3 días [1].', answer: 'Tardan 3 días [1].', facts: [] })
    expect(r.citations).toHaveLength(2)
    // the context is not stored in the chat history
    expect(mock.calls[0]!.messages).toEqual([{ role: 'user', content: '¿cuánto tarda el envío?' }])
  })

  it('appendSources adds the cited sources to the reply but not to the history', async () => {
    const mock = new MockAIProvider({ reply: 'Tardan 3 días [1].' })
    const store = new MemoryStore()
    const ai = new AIClient(mock, new ContextManager(store), { rag: { retriever: fakeRetriever(), appendSources: true } })
    expect(await ai.replyInChat('c', 'envío')).toBe('Tardan 3 días [1].\n\nFuentes: faq.md › Envíos')
    expect((await store.getConversation('c'))!.at(-1)!.content).toBe('Tardan 3 días [1].')
    const custom = new AIClient(mock, new ContextManager(store), {
      rag: { retriever: fakeRetriever(), appendSources: (cs) => `📚 ${cs.length}` },
    })
    expect(await custom.replyInChat('d', 'envío')).toBe('Tardan 3 días [1].\n\n📚 1')
  })

  it('custom instructions replace the default ones', async () => {
    const mock = new MockAIProvider()
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { rag: { retriever: fakeRetriever(), instructions: 'Usa SOLO el contexto.' } })
    await ai.replyInChat('c', 'x')
    expect(mock.calls[0]!.system).toContain('## Reference context\nUsa SOLO el contexto.\n\n[1]')
  })

  it('no hits → no context block; retrieval errors are reported and the reply goes on', async () => {
    const mock = new MockAIProvider({ reply: 'sin datos' })
    const errors: unknown[] = []
    const empty = new AIClient(mock, new ContextManager(new MemoryStore()), { rag: { retriever: fakeRetriever([]) } })
    await empty.replyInChat('c', 'x')
    expect(mock.calls[0]!.system).toBeUndefined()
    const broken: AIRetriever = { retrieve: async () => { throw new Error('index down') } }
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { rag: { retriever: broken }, onError: (e, stage) => errors.push([e, stage]) })
    expect(await ai.replyInChat('c', 'x')).toBe('sin datos')
    expect(errors).toEqual([[new Error('index down'), 'rag']])
  })

  it('a slow retriever is cut by rag.timeoutMs: the reply goes on without context', async () => {
    const mock = new MockAIProvider({ reply: 'sigo' })
    const errors: unknown[] = []
    let aborted = false
    const slow: AIRetriever = {
      retrieve: (_q, o) => new Promise((_, reject) => {
        o?.signal?.addEventListener('abort', () => { aborted = true; reject(o.signal!.reason) })
      }),
    }
    const ai = new AIClient(mock, new ContextManager(new MemoryStore()), { rag: { retriever: slow, timeoutMs: 20 }, onError: (e, stage) => errors.push([e, stage]) })
    expect(await ai.replyInChat('c', 'x')).toBe('sigo')
    expect(aborted).toBe(true)
    expect(errors).toHaveLength(1)
    expect((errors[0] as [Error, string])[1]).toBe('rag')
    expect((errors[0] as [Error, string])[0].name).toBe('AITimeoutError')
  })

  it('a throwing onError never breaks the reply', async () => {
    const broken: AIRetriever = { retrieve: async () => { throw new Error('index down') } }
    const ai = new AIClient(new MockAIProvider({ reply: 'ok' }), new ContextManager(new MemoryStore()), {
      rag: { retriever: broken },
      onError: () => { throw new Error('logger exploded') },
    })
    expect(await ai.replyInChat('c', 'x')).toBe('ok')
  })
})

describe('aiPlugin({ rag })', () => {
  it('the autoreply answers with retrieved context; the retriever is warmed up at install', async () => {
    const mock = new MockAIProvider({ reply: (i) => (i.system?.includes('3 días') ? 'Tardan 3 días [1].' : 'no sé') })
    const retriever = fakeRetriever()
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: mock, rag: { retriever, appendSources: true } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(retriever.warmed()).toBe(1)
    await chat.send('¿cuánto tarda el envío?')
    await chat.expectReply('Tardan 3 días [1].\n\nFuentes: faq.md › Envíos')
  })

  it('a failing warmup is logged, not thrown', async () => {
    const retriever: AIRetriever = { retrieve: async () => [], warmup: async () => { throw new Error('bad index') } }
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'ok' }), rag: retriever }))
    await chat.send('hola')
    await chat.expectReply('ok')
  })
})
