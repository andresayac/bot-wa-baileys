import { describe, it, expect, vi } from 'vitest'
import { MemoryStore, UserDataService } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'
import { ContextManager } from '../src/ContextManager.js'
import { AIClient } from '../src/AIClient.js'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { LazyProvider } from '../src/providers/LazyProvider.js'
import { OllamaProvider } from '../src/providers/ollama.js'
import { GeminiProvider } from '../src/providers/gemini.js'
import type { GeminiLike, GeminiModelLike, GeminiResponse } from '../src/providers/gemini.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import type { OpenAIChatCompletion, OpenAILike, OpenAIStreamChunk } from '../src/providers/openai.js'
import { resolveProvider } from '../src/providers/resolve.js'
import { validateArgs } from '../src/tools/schema.js'
import { MemoryManager } from '../src/memory/MemoryManager.js'
import { aiPlugin } from '../src/plugin.js'

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const s of it) out.push(s)
  return out
}

/** A `fetch` answering with an NDJSON body made of `chunks` (split exactly as given). */
function ndjsonFetch(chunks: string[], init: ResponseInit = {}) {
  return vi.fn<typeof fetch>(async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s))
        c.close()
      },
    })
    return new Response(body, init)
  })
}

describe('ContextManager — history the providers accept', () => {
  it('an odd maxMessages never leaves an assistant turn first', async () => {
    const cm = new ContextManager(new MemoryStore({}), { maxMessages: 3 })
    await cm.appendMany('k', [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }])
    await cm.appendMany('k', [{ role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }])
    const h = await cm.history('k')
    expect(h[0]?.role).toBe('user')
    expect(h.map((m) => m.content)).toEqual(['u2', 'a2'])
  })

  it('history() drops empty turns and a leading assistant turn already stored', async () => {
    const store = new MemoryStore({})
    await store.setConversation('k', [
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ])
    const cm = new ContextManager(store)
    expect(await cm.history('k')).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ])
  })
})

describe('AIClient — empty answers', () => {
  it('an empty model answer is not stored in the chat history', async () => {
    let calls = 0
    const mock = new MockAIProvider({ reply: (i) => (++calls === 1 ? '' : `n=${i.messages.length}`) })
    const cm = new ContextManager(new MemoryStore({}))
    const ai = new AIClient(mock, cm)
    expect(await ai.replyInChat('k', 'hola')).toBe('')
    expect(await cm.history('k')).toEqual([])
    // The next turn starts clean (no blank assistant message the provider would reject).
    expect(await ai.replyInChat('k', 'otra')).toBe('n=1')
  })

  it('the autoreply answers errorMessage instead of an empty message', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: '  ' }), errorMessage: 'sin respuesta' }))
    await chat.send('hola')
    await chat.expectReply('sin respuesta')
  })
})

describe('LazyProvider', () => {
  it('retries the factory after a failure instead of caching the rejection', async () => {
    let attempts = 0
    const lazy = new LazyProvider(async () => {
      if (++attempts === 1) throw new Error('transient')
      return new MockAIProvider({ reply: 'ok' })
    })
    await expect(lazy.warmup()).rejects.toThrow('transient')
    const r = await lazy.generate({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('ok')
    expect(attempts).toBe(2)
    // Success is memoized.
    await lazy.generate({ messages: [{ role: 'user', content: 'y' }] })
    expect(attempts).toBe(2)
  })
})

describe('OllamaProvider — streaming and errors', () => {
  it('yields a last line without a trailing newline and reports done_reason', async () => {
    const fetchImpl = ndjsonFetch([
      '{"message":{"content":"Ho"}}\n{"message":{"con',
      'tent":"la"}}\n',
      '{"message":{"content":"!"},"done":true,"done_reason":"stop"}',
    ])
    const p = new OllamaProvider({ model: 'llama' }, fetchImpl)
    let stopReason: string | undefined = 'unset'
    const chunks = await collect(p.stream({ messages: [{ role: 'user', content: 'hi' }], onStreamEnd: (i) => { stopReason = i.stopReason } }))
    expect(chunks.join('')).toBe('Hola!')
    expect(stopReason).toBe('stop')
  })

  it('an {"error"} line in the stream rejects with the server message', async () => {
    const fetchImpl = ndjsonFetch(['{"message":{"content":"a"}}\n{"error":"model crashed"}\n'])
    const p = new OllamaProvider({ model: 'llama' }, fetchImpl)
    await expect(collect(p.stream({ messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(/model crashed/)
  })

  it('a non-2xx answer includes the server error in the message', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: 'model "nope" not found, try pulling it first' }, { status: 404 }))
    const p = new OllamaProvider({ model: 'nope' }, fetchImpl)
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/404.*not found/)
  })

  it('maxTokens is sent as options.num_predict (only when set)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message: { content: 'ok' } }))
    const p = new OllamaProvider({ model: 'llama' }, fetchImpl)
    await p.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 77 })
    await p.generate({ messages: [{ role: 'user', content: 'hi' }] })
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as { options?: { num_predict?: number } })
    expect(bodies[0]?.options).toEqual({ num_predict: 77 })
    expect(bodies[1]?.options).toBeUndefined()
  })
})

describe('GeminiProvider — blocked answers and stream end', () => {
  function gemini(model: GeminiModelLike) {
    const client: GeminiLike = { getGenerativeModel: () => model }
    return new GeminiProvider(client, {})
  }

  it('a SAFETY-blocked answer is a refusal, not a thrown error', async () => {
    const response: GeminiResponse = {
      text: () => { throw new Error('Candidate was blocked due to SAFETY') },
      candidates: [{ finishReason: 'SAFETY' }],
    }
    const p = gemini({ generateContent: async () => ({ response }) })
    const r = await p.generate({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.stopReason).toBe('refusal')
    expect(r.text).toBe('')
  })

  it('a blocked prompt (promptFeedback.blockReason) is a refusal too', async () => {
    const response = {
      text: () => { throw new Error('Text not available. Response was blocked due to SAFETY') },
      promptFeedback: { blockReason: 'SAFETY' },
    } as GeminiResponse
    const p = gemini({ generateContent: async () => ({ response }) })
    expect((await p.generate({ messages: [{ role: 'user', content: 'x' }] })).stopReason).toBe('refusal')
  })

  it('other text() failures still throw', async () => {
    const response: GeminiResponse = { text: () => { throw new Error('boom') }, candidates: [{ finishReason: 'OTHER' }] }
    const p = gemini({ generateContent: async () => ({ response }) })
    await expect(p.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow('boom')
  })

  it('stream() reports the finish reason through onStreamEnd (SAFETY → refusal)', async () => {
    async function* chunks() {
      yield { text: () => 'Hola', candidates: [{}] }
      yield { text: () => { throw new Error('blocked') }, candidates: [{ finishReason: 'SAFETY' }] }
    }
    const p = gemini({
      generateContent: async () => { throw new Error('unused') },
      generateContentStream: async () => ({ stream: chunks() }),
    })
    let stopReason: string | undefined
    const out = await collect(p.stream({ messages: [{ role: 'user', content: 'x' }], onStreamEnd: (i) => { stopReason = i.stopReason } }))
    expect(out).toEqual(['Hola'])
    expect(stopReason).toBe('refusal')
  })

  it('stream() without generateContentStream still calls onStreamEnd', async () => {
    const response: GeminiResponse = { text: () => 'hi', candidates: [{ finishReason: 'STOP' }] }
    const p = gemini({ generateContent: async () => ({ response }) })
    let stopReason: string | undefined
    expect(await collect(p.stream({ messages: [{ role: 'user', content: 'x' }], onStreamEnd: (i) => { stopReason = i.stopReason } }))).toEqual(['hi'])
    expect(stopReason).toBe('STOP')
  })
})

describe('OpenAIProvider — refusals', () => {
  function client(create: OpenAILike['chat']['completions']['create']): OpenAILike {
    return { chat: { completions: { create } } }
  }

  it('message.refusal maps to stopReason "refusal"', async () => {
    const completion = {
      model: 'gpt',
      choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }],
    } as OpenAIChatCompletion
    const p = new OpenAIProvider(client(async () => completion), { model: 'gpt' })
    const r = await p.generate({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.stopReason).toBe('refusal')
    expect(r.text).toBe('')
  })

  it('a streamed refusal delta reports stopReason "refusal" and is not yielded as text', async () => {
    async function* chunks(): AsyncIterable<OpenAIStreamChunk> {
      yield { choices: [{ delta: { refusal: 'No.' } as { content?: string } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    }
    const p = new OpenAIProvider(client(async () => chunks()), { model: 'gpt' })
    let stopReason: string | undefined
    const out = await collect(p.stream({ messages: [{ role: 'user', content: 'x' }], onStreamEnd: (i) => { stopReason = i.stopReason } }))
    expect(out).toEqual([])
    expect(stopReason).toBe('refusal')
  })
})

describe('OpenAIProvider — error bodies', () => {
  it('a 200 answer carrying { error } (OpenRouter & co) rejects with its message', async () => {
    const body = { error: { message: 'Provider returned error', code: 502 } } as unknown as OpenAIChatCompletion
    const client: OpenAILike = { chat: { completions: { create: async () => body } } }
    const p = new OpenAIProvider(client, { model: 'm' }, { name: 'openrouter' })
    await expect(p.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/openrouter.*Provider returned error/)
  })
})

describe('resolveProvider — anthropic', () => {
  it('passes baseUrl to the Anthropic SDK (proxies, gateways)', async () => {
    const p = await resolveProvider({ provider: 'anthropic', apiKey: 'sk-test', baseUrl: 'http://gateway.local/anthropic' })
    const sdk = (p as unknown as { client: { baseURL?: string } }).client
    expect(sdk.baseURL).toBe('http://gateway.local/anthropic')
  })
})

describe('validateArgs — JSON Schema own keys', () => {
  it('a required key is not satisfied by an inherited property', () => {
    const tool = { description: 'd', schema: { type: 'object', required: ['toString'] }, handler: () => 'x' }
    expect(validateArgs(tool, {}).ok).toBe(false)
  })
  it('additionalProperties:false rejects keys named like Object.prototype members', () => {
    const tool = { description: 'd', schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, handler: () => 'x' }
    expect(validateArgs(tool, { a: 'x', constructor: 1 }).ok).toBe(false)
  })
})

describe('formatMarkdown html — link attributes', () => {
  it('escapes a double quote inside a link URL (no broken / injected attribute)', async () => {
    const { formatMarkdown } = await import('../src/format.js')
    const out = formatMarkdown('[x](http://a.example/"onclick="y)', 'html')
    expect(out).toBe('<a href="http://a.example/&quot;onclick=&quot;y">x</a>')
  })
})

describe('memory extraction — truncated answers', () => {
  it('an answer cut off by the token cap is reported with an actionable message', async () => {
    const store = new MemoryStore()
    const users = new UserDataService(store)
    const memory = new MemoryManager((id) => users.for(id), { autoExtract: { maxTokens: 50 } })
    const mock = new MockAIProvider({ reply: { text: '{"facts":["Se lla', stopReason: 'max_tokens' } })
    const errors: unknown[] = []
    const ai = new AIClient(mock, new ContextManager(store), { memory, onError: (e) => errors.push(e) })
    expect(await ai.extractMemory('u', 'me llamo Ana', 'hola Ana')).toEqual([])
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/maxTokens.*50/)
  })
})

describe('resolveProvider — unknown name', () => {
  it('lists the valid provider names', async () => {
    await expect(resolveProvider({ provider: 'claude' as never })).rejects.toThrow(/claude.*anthropic.*openai.*ollama.*gemini.*deepseek/)
  })
})
