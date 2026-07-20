import { describe, it, expect, vi } from 'vitest'
import { loadModule } from '../src/providers/loadModule.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import { OllamaProvider } from '../src/providers/ollama.js'

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
    const p = new OpenAIProvider(client as any, { model: 'gpt-x' })
    const r = await p.generate({ system: 'S', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('hey')
    const args = client.chat.completions.create.mock.calls[0][0]
    expect(args.messages[0]).toEqual({ role: 'system', content: 'S' })
    expect(args.messages[1]).toEqual({ role: 'user', content: 'hi' })
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
