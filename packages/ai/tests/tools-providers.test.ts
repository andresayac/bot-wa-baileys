import { describe, it, expect, vi } from 'vitest'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import type { AnthropicLike, AnthropicMessage, AnthropicRequestOptions } from '../src/providers/anthropic.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import type { OpenAIChatCompletion, OpenAILike, OpenAIRequestOptions } from '../src/providers/openai.js'
import { OllamaProvider } from '../src/providers/ollama.js'
import { GeminiProvider, toGeminiSchema } from '../src/providers/gemini.js'
import type { GeminiLike, GeminiModelLike, GeminiRequestOptions, GeminiResponse } from '../src/providers/gemini.js'
import type { AIChatMessage } from '../src/types.js'
import type { AIToolDefinition } from '../src/tools/types.js'

type Args = Record<string, unknown>

const TOOLS: AIToolDefinition[] = [
  { name: 'buscar', description: 'Busca productos', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } },
]

/** A full exchange after one tool round-trip. */
const HISTORY: AIChatMessage[] = [
  { role: 'user', content: '¿hay pan?' },
  { role: 'assistant', content: 'Busco…', toolCalls: [{ id: 'c1', name: 'buscar', args: { q: 'pan' } }] },
  { role: 'tool', content: '[1]', results: [{ callId: 'c1', name: 'buscar', content: '[1]' }, { callId: 'c2', name: 'x', content: 'Error: boom', isError: true }] },
]

describe('AnthropicProvider tools', () => {
  it('sends tools as input_schema and parses tool_use blocks (keeping raw content for replay)', async () => {
    const content = [
      { type: 'thinking', thinking: '...' },
      { type: 'tool_use', id: 'toolu_1', name: 'buscar', input: { q: 'pan' } },
    ]
    const create = vi.fn(async (_a: Args, _o?: AnthropicRequestOptions): Promise<AnthropicMessage> => ({ content, stop_reason: 'tool_use', model: 'm' }))
    const p = new AnthropicProvider({ messages: { create } } satisfies AnthropicLike, {})
    const r = await p.generate({ messages: [{ role: 'user', content: 'hola' }], tools: TOOLS })
    const [args] = create.mock.calls[0]!
    expect(args.tools).toEqual([{ name: 'buscar', description: 'Busca productos', input_schema: TOOLS[0]!.parameters }])
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'buscar', args: { q: 'pan' } }])
    expect(r.providerData).toBe(content)
    expect(r.stopReason).toBe('tool_use')
  })
  it('maps assistant tool calls and tool results; replays providerData verbatim', async () => {
    const create = vi.fn(async (_a: Args): Promise<AnthropicMessage> => ({ content: [{ type: 'text', text: 'ok' }], model: 'm' }))
    const p = new AnthropicProvider({ messages: { create } }, {})
    await p.generate({ messages: HISTORY })
    const [args] = create.mock.calls[0]!
    expect(args.tools).toBeUndefined()
    expect(args.messages).toEqual([
      { role: 'user', content: '¿hay pan?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Busco…' }, { type: 'tool_use', id: 'c1', name: 'buscar', input: { q: 'pan' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '[1]' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'Error: boom', is_error: true },
      ] },
    ])
    const raw = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'c1', name: 'buscar', input: { q: 'pan' } }]
    await p.generate({ messages: [HISTORY[0]!, { ...HISTORY[1]!, providerData: raw } as AIChatMessage, HISTORY[2]!] })
    const [args2] = create.mock.calls[1]!
    expect((args2.messages as Args[])[1]).toEqual({ role: 'assistant', content: raw })
  })
})

describe('OpenAIProvider tools (incl. OpenAI-compatible presets)', () => {
  function fake(completion: OpenAIChatCompletion) {
    const create = vi.fn(async (_a: Args, _o?: OpenAIRequestOptions): Promise<OpenAIChatCompletion> => completion)
    return { client: { chat: { completions: { create } } } satisfies OpenAILike, create }
  }
  it('sends function tools and parses tool_calls (JSON arguments)', async () => {
    const { client, create } = fake({
      model: 'gpt',
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'buscar', arguments: '{"q":"pan"}' } },
        { id: 'call_2', type: 'function', function: { name: 'buscar', arguments: '{bad json' } },
      ] } }],
    })
    const p = new OpenAIProvider(client, { model: 'gpt' }, { name: 'deepseek', maxTokensField: 'max_tokens' })
    const r = await p.generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS })
    const [args] = create.mock.calls[0]!
    expect(args.tools).toEqual([{ type: 'function', function: { name: 'buscar', description: 'Busca productos', parameters: TOOLS[0]!.parameters } }])
    expect(r.text).toBe('')
    expect(r.stopReason).toBe('tool_calls')
    expect(r.toolCalls).toEqual([
      { id: 'call_1', name: 'buscar', args: { q: 'pan' } },
      { id: 'call_2', name: 'buscar', args: '{bad json' },
    ])
  })
  it('maps history: assistant tool_calls + one tool message per result', async () => {
    const { client, create } = fake({ model: 'gpt', choices: [{ message: { content: 'listo' } }] })
    const p = new OpenAIProvider(client, { model: 'gpt' })
    const r = await p.generate({ system: 'S', messages: HISTORY })
    expect(r.toolCalls).toBeUndefined()
    const [args] = create.mock.calls[0]!
    expect(args.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: '¿hay pan?' },
      { role: 'assistant', content: 'Busco…', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'buscar', arguments: '{"q":"pan"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '[1]' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: boom' },
    ])
  })
})

describe('GeminiProvider tools', () => {
  function fakeGemini(response: GeminiResponse) {
    const generateContent = vi.fn(async (_a: Args, _o?: GeminiRequestOptions) => ({ response }))
    const model: GeminiModelLike = { generateContent }
    const client: GeminiLike = { getGenerativeModel: () => model }
    return { client, generateContent }
  }
  it('sends functionDeclarations (Gemini-safe schema) and reads functionCalls()', async () => {
    const { client, generateContent } = fakeGemini({
      text: () => '',
      functionCalls: () => [{ name: 'buscar', args: { q: 'pan' } }],
    })
    const p = new GeminiProvider(client, {})
    const r = await p.generate({
      messages: [{ role: 'user', content: 'x' }],
      tools: [...TOOLS, { name: 'hora', description: 'Hora', parameters: { type: 'object', properties: {} } }],
    })
    const [args] = generateContent.mock.calls[0]!
    expect(args.tools).toEqual([{ functionDeclarations: [
      { name: 'buscar', description: 'Busca productos', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'hora', description: 'Hora' },
    ] }])
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'buscar', args: { q: 'pan' } })
    expect(r.toolCalls?.[0]?.id).toMatch(/^gemini_call_/)
  })
  it('falls back to candidate parts and tolerates text() throwing', async () => {
    const { client } = fakeGemini({
      text: () => { throw new Error('no text') },
      candidates: [{ content: { parts: [{ functionCall: { name: 'buscar', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
    })
    const r = await new GeminiProvider(client, {}).generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS })
    expect(r.text).toBe('')
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'buscar', args: { q: 'x' } })
  })
  it('keeps the raw candidate parts (thoughtSignature) as providerData and replays them verbatim', async () => {
    const raw = [
      { text: 'pienso' },
      { functionCall: { name: 'buscar', args: { q: 'pan' } }, thoughtSignature: 'sig-1' },
    ]
    const { client, generateContent } = fakeGemini({
      text: () => 'pienso',
      candidates: [{ content: { parts: raw }, finishReason: 'STOP' }],
    })
    const p = new GeminiProvider(client, {})
    const r = await p.generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS })
    expect(r.providerData).toEqual(raw)
    await p.generate({ messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: r.text, toolCalls: r.toolCalls, providerData: r.providerData },
      { role: 'tool', content: '[1]', results: [{ callId: r.toolCalls![0]!.id, name: 'buscar', content: '[1]' }] },
    ], tools: TOOLS })
    const [args] = generateContent.mock.calls[1]!
    expect((args.contents as Args[])[1]).toEqual({ role: 'model', parts: raw })
  })
  it('a blocked response (text() throws, no tool calls) is a refusal', async () => {
    const { client } = fakeGemini({
      text: () => { throw new Error('Response was blocked due to SAFETY') },
      candidates: [{ finishReason: 'SAFETY' }],
    })
    const r = await new GeminiProvider(client, {}).generate({ messages: [{ role: 'user', content: 'x' }] })
    expect(r).toMatchObject({ text: '', stopReason: 'refusal' })
    expect(r.toolCalls).toBeUndefined()
  })
  it('a text() failure that is not a block (no tool calls) still rejects', async () => {
    const { client } = fakeGemini({
      text: () => { throw new Error('unexpected shape') },
      candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }],
    })
    await expect(new GeminiProvider(client, {}).generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/unexpected shape/)
  })
  it('maps history to model functionCall + function functionResponse parts', async () => {
    const { client, generateContent } = fakeGemini({ text: () => 'listo' })
    await new GeminiProvider(client, {}).generate({ messages: HISTORY })
    const [args] = generateContent.mock.calls[0]!
    expect(args.contents).toEqual([
      { role: 'user', parts: [{ text: '¿hay pan?' }] },
      { role: 'model', parts: [{ text: 'Busco…' }, { functionCall: { name: 'buscar', args: { q: 'pan' } } }] },
      { role: 'function', parts: [
        { functionResponse: { name: 'buscar', response: { result: '[1]' } } },
        { functionResponse: { name: 'x', response: { error: 'Error: boom' } } },
      ] },
    ])
  })
  it('toGeminiSchema strips unsupported keywords recursively', () => {
    expect(toGeminiSchema({
      $schema: 'x', type: 'object', additionalProperties: false,
      properties: { a: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { b: { type: 'string', default: 'z' } } } } },
    })).toEqual({ type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } } })
  })
})

describe('OllamaProvider tools', () => {
  function fakeFetch(payload: unknown) {
    const calls: Array<{ url: string; body: Args }> = []
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Args })
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return { impl: impl as unknown as typeof fetch, calls }
  }
  it('sends tools and parses message.tool_calls (object arguments, synthesized ids)', async () => {
    const { impl, calls } = fakeFetch({ model: 'llama', done_reason: 'stop', message: { content: '', tool_calls: [{ function: { name: 'buscar', arguments: { q: 'pan' } } }] } })
    const r = await new OllamaProvider({ model: 'llama' }, impl).generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS })
    expect(calls[0]!.body.tools).toEqual([{ type: 'function', function: { name: 'buscar', description: 'Busca productos', parameters: TOOLS[0]!.parameters } }])
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'buscar', args: { q: 'pan' } }])
  })
  it('maps history: assistant tool_calls + tool messages with tool_name', async () => {
    const { impl, calls } = fakeFetch({ model: 'llama', message: { content: 'listo' } })
    const r = await new OllamaProvider({ model: 'llama' }, impl).generate({ messages: HISTORY })
    expect(r.text).toBe('listo')
    expect(calls[0]!.body.tools).toBeUndefined()
    expect(calls[0]!.body.messages).toEqual([
      { role: 'user', content: '¿hay pan?' },
      { role: 'assistant', content: 'Busco…', tool_calls: [{ function: { name: 'buscar', arguments: { q: 'pan' } } }] },
      { role: 'tool', content: '[1]', tool_name: 'buscar' },
      { role: 'tool', content: 'Error: boom', tool_name: 'x' },
    ])
  })
})
