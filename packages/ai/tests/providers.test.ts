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
import { OpenAIProvider } from '../src/providers/openai.js'
import { OllamaProvider } from '../src/providers/ollama.js'
import { GeminiProvider } from '../src/providers/gemini.js'
import { PRESETS, isPreset } from '../src/providers/presets.js'
import { resolveProvider } from '../src/providers/resolve.js'

describe('loadModule', () => {
  it('throws an actionable error when the module is missing', async () => {
    await expect(loadModule('this-module-does-not-exist-xyz', 'pnpm add xyz')).rejects.toThrow(/pnpm add xyz/)
  })
})

describe('AnthropicProvider', () => {
  it('maps input to messages.create and reads text blocks + usage', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hola' }],
          stop_reason: 'end_turn',
          model: 'claude-opus-4-8',
          usage: { input_tokens: 3, output_tokens: 2 },
        })),
      },
    }
    const p = new AnthropicProvider(client as any, { model: 'claude-opus-4-8', maxTokens: 512 })
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('hola')
    expect(r.usage).toEqual({ input: 3, output: 2 })
    const args = client.messages.create.mock.calls[0][0]
    expect(args.system).toBe('S')
    expect(args.max_tokens).toBe(512)
    expect(args.thinking).toEqual({ type: 'adaptive' })
    expect(args.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect('temperature' in args).toBe(false)
  })
  it('surfaces refusal stop_reason', async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [], stop_reason: 'refusal', model: 'm', usage: { input_tokens: 0, output_tokens: 0 } })) } }
    const p = new AnthropicProvider(client as any, {})
    const r = await p.generate({ messages: [] })
    expect(r.stopReason).toBe('refusal')
    expect(r.text).toBe('')
  })
})

describe('OpenAIProvider', () => {
  it('prepends system and reads choice content', async () => {
    const client = { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: 'hey' }, finish_reason: 'stop' }], model: 'gpt-x', usage: { prompt_tokens: 1, completion_tokens: 1 } })) } } }
    const p = new OpenAIProvider(client as any, { model: 'gpt-x', maxTokens: 512 })
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('hey')
    const args = client.chat.completions.create.mock.calls[0][0]
    expect(args.messages[0]).toEqual({ role: 'system', content: 'S' })
    expect(args.messages[1]).toEqual({ role: 'user', content: 'hi' })
    // Current OpenAI chat models require max_completion_tokens, not max_tokens.
    expect(args.max_completion_tokens).toBe(512)
    expect('max_tokens' in args).toBe(false)
  })
})

describe('OllamaProvider', () => {
  it('posts to /api/chat and reads message.content', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ message: { content: 'ola' }, model: 'llama' }) })) as any
    const p = new OllamaProvider({ model: 'llama', baseUrl: 'http://h:11434' }, fetchImpl)
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('ola')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://h:11434/api/chat')
    expect(JSON.parse(init.body).messages[0]).toEqual({ role: 'system', content: 'S' })
  })
})

describe('OpenAIProvider — preset mode', () => {
  it('uses max_tokens (not max_completion_tokens) and a custom name', async () => {
    const client = { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } })) } } }
    const p = new OpenAIProvider(client as any, { model: 'deepseek-chat', maxTokens: 300 }, { name: 'deepseek', maxTokensField: 'max_tokens' })
    await p.generate({ messages: [{ role: 'user', content: 'hi' }] })
    const args = client.chat.completions.create.mock.calls[0][0]
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
    const model = {
      generateContent: vi.fn(async () => ({ response: { text: () => 'hola gemini', usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 } } })),
    }
    const client = { getGenerativeModel: vi.fn(() => model) }
    const p = new GeminiProvider(client as any, {})
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'prev' }] })
    expect(r.text).toBe('hola gemini')
    expect(r.usage).toEqual({ input: 4, output: 3 })
    const args = model.generateContent.mock.calls[0][0]
    expect(args.systemInstruction).toEqual({ text: 'S' })
    expect(args.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'prev' }] },
    ])
    expect(client.getGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-2.0-flash' })
  })

  it('streams text chunks', async () => {
    async function* chunks() { yield { text: () => 'a' }; yield { text: () => 'b' } }
    const model = { generateContentStream: vi.fn(async () => ({ stream: chunks() })) }
    const client = { getGenerativeModel: () => model }
    const p = new GeminiProvider(client as any, {})
    let out = ''
    for await (const t of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) out += t
    expect(out).toBe('ab')
  })
})
