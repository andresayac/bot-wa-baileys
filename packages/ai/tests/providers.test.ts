import { describe, it, expect, vi } from 'vitest'

// Hermetic: stub the Gemini SDK so resolveProvider's lazy import never depends
// on whether the optional peer happens to be installed.
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() { return {} }
  },
}))

import { loadModule } from '../src/providers/loadModule.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import type { AnthropicLike, AnthropicMessage, AnthropicRequestOptions } from '../src/providers/anthropic.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import type { OpenAIChatCompletion, OpenAILike, OpenAIRequestOptions } from '../src/providers/openai.js'
import { OllamaProvider } from '../src/providers/ollama.js'
import { GeminiProvider } from '../src/providers/gemini.js'
import type { GeminiLike, GeminiModelLike, GeminiRequestOptions } from '../src/providers/gemini.js'
import { PRESETS, isPreset } from '../src/providers/presets.js'
import { resolveProvider } from '../src/providers/resolve.js'

/** Request args every fake SDK method receives (the providers build a plain record). */
type Args = Record<string, unknown>

/** Arguments of the first recorded call; fails the test (not just the types) if there was none. */
function firstCall<T extends unknown[]>(calls: T[]): T {
  const call = calls[0]
  expect(call, 'expected the fake to have been called').toBeDefined()
  if (call === undefined) throw new Error('expected the fake to have been called')
  return call
}

/** A fake OpenAI-compatible client whose `create` always resolves `completion`. */
function fakeOpenAI(completion: OpenAIChatCompletion) {
  const create = vi.fn(async (_args: Args, _opts?: OpenAIRequestOptions): Promise<OpenAIChatCompletion> => completion)
  const client: OpenAILike = { chat: { completions: { create } } }
  return { client, create }
}

describe('loadModule', () => {
  it('throws an actionable error when the module is missing', async () => {
    await expect(loadModule('this-module-does-not-exist-xyz', 'pnpm add xyz')).rejects.toThrow(/pnpm add xyz/)
  })
})

describe('AnthropicProvider', () => {
  it('maps input to messages.create and reads text blocks + usage', async () => {
    // A real SDK thinking block (carries `thinking`, not `text`); it must be skipped.
    const thinkingBlock = { type: 'thinking', thinking: '' }
    const create = vi.fn(async (_args: Args, _opts?: AnthropicRequestOptions): Promise<AnthropicMessage> => ({
      content: [thinkingBlock, { type: 'text', text: 'hola' }],
      stop_reason: 'end_turn',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 3, output_tokens: 2 },
    }))
    const client: AnthropicLike = { messages: { create } }
    const p = new AnthropicProvider(client, { model: 'claude-opus-4-8', maxTokens: 512 })
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('hola')
    expect(r.usage).toEqual({ input: 3, output: 2 })
    const [args] = firstCall(create.mock.calls)
    expect(args.system).toBe('S')
    expect(args.max_tokens).toBe(512)
    expect(args.thinking).toEqual({ type: 'adaptive' })
    expect(args.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect('temperature' in args).toBe(false)
  })
  it('surfaces refusal stop_reason', async () => {
    const client: AnthropicLike = {
      messages: { create: vi.fn(async (): Promise<AnthropicMessage> => ({ content: [], stop_reason: 'refusal', model: 'm', usage: { input_tokens: 0, output_tokens: 0 } })) },
    }
    const p = new AnthropicProvider(client, {})
    const r = await p.generate({ messages: [] })
    expect(r.stopReason).toBe('refusal')
    expect(r.text).toBe('')
  })
})

describe('OpenAIProvider', () => {
  it('prepends system and reads choice content', async () => {
    const { client, create } = fakeOpenAI({ choices: [{ message: { content: 'hey' }, finish_reason: 'stop' }], model: 'gpt-x', usage: { prompt_tokens: 1, completion_tokens: 1 } })
    const p = new OpenAIProvider(client, { model: 'gpt-x', maxTokens: 512 })
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('hey')
    const [args] = firstCall(create.mock.calls)
    expect(args.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'hi' },
    ])
    // Current OpenAI chat models require max_completion_tokens, not max_tokens.
    expect(args.max_completion_tokens).toBe(512)
    expect('max_tokens' in args).toBe(false)
  })
})

describe('OllamaProvider', () => {
  it('posts to /api/chat and reads message.content', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message: { content: 'ola' }, model: 'llama' }))
    const p = new OllamaProvider({ model: 'llama', baseUrl: 'http://h:11434' }, fetchImpl)
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('ola')
    const [url, init] = firstCall(fetchImpl.mock.calls)
    expect(url).toBe('http://h:11434/api/chat')
    const body = init?.body
    expect(body).toBeTypeOf('string')
    if (typeof body !== 'string') return // unreachable: the assertion above already failed
    expect(JSON.parse(body).messages[0]).toEqual({ role: 'system', content: 'S' })
  })
})

describe('OpenAIProvider — preset mode', () => {
  it('uses max_tokens (not max_completion_tokens) and a custom name', async () => {
    const { client, create } = fakeOpenAI({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } })
    const p = new OpenAIProvider(client, { model: 'deepseek-chat', maxTokens: 300 }, { name: 'deepseek', maxTokensField: 'max_tokens' })
    await p.generate({ messages: [{ role: 'user', content: 'hi' }] })
    const [args] = firstCall(create.mock.calls)
    expect(args.max_tokens).toBe(300)
    expect('max_completion_tokens' in args).toBe(false)
    expect(p.name).toBe('deepseek')
  })
})

describe('presets', () => {
  it('isPreset recognizes preset names and rejects native ones', () => {
    for (const n of ['deepseek', 'qwen', 'glm', 'kimi', 'groq', 'openrouter', 'mistral', 'grok', 'together']) {
      expect(isPreset(n)).toBe(true)
    }
    expect(isPreset('anthropic')).toBe(false)
    expect(isPreset('gemini')).toBe(false)
  })

  it('every preset has a baseUrl, default model and env var', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.baseUrl).toMatch(/^https:\/\//)
      expect(preset.model).toBeTruthy()
      expect(preset.env).toMatch(/_API_KEY$/)
      expect(preset.maxTokensField).toBe('max_tokens')
    }
  })

  it('resolveProvider maps a preset to an OpenAIProvider (named, default model)', async () => {
    const p = await resolveProvider({ provider: 'deepseek', apiKey: 'test-key' })
    expect(p).toBeInstanceOf(OpenAIProvider)
    expect(p.name).toBe('deepseek')
  })

  it('resolveProvider for gemini returns a GeminiProvider', async () => {
    const p = await resolveProvider({ provider: 'gemini', apiKey: 'k' })
    expect(p).toBeInstanceOf(GeminiProvider)
    expect(p.name).toBe('gemini')
  })
})

describe('GeminiProvider', () => {
  it('maps messages (assistant -> model role) and reads text + usage', async () => {
    const generateContent = vi.fn(async (_args: Args, _opts?: GeminiRequestOptions) => (
      { response: { text: () => 'hola gemini', usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 } } }
    ))
    const model: GeminiModelLike = { generateContent }
    const getGenerativeModel = vi.fn((_cfg: { model: string }) => model)
    const client: GeminiLike = { getGenerativeModel }
    const p = new GeminiProvider(client, {})
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'prev' }] })
    expect(r.text).toBe('hola gemini')
    expect(r.usage).toEqual({ input: 4, output: 3 })
    const [args] = firstCall(generateContent.mock.calls)
    expect(args.systemInstruction).toEqual({ text: 'S' })
    expect(args.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'prev' }] },
    ])
    expect(getGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-2.0-flash' })
  })

  it('streams text chunks', async () => {
    async function* chunks() { yield { text: () => 'a' }; yield { text: () => 'b' } }
    const model: GeminiModelLike = {
      generateContent: vi.fn(async () => { throw new Error('stream() must use generateContentStream') }),
      generateContentStream: vi.fn(async () => ({ stream: chunks() })),
    }
    const client: GeminiLike = { getGenerativeModel: () => model }
    const p = new GeminiProvider(client, {})
    let out = ''
    for await (const t of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) out += t
    expect(out).toBe('ab')
  })
})
