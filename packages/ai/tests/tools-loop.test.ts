import { describe, it, expect } from 'vitest'
import { MemoryStore } from '@bot-wa/core'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { AIClient } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { AIToolCancelledError, defineTool } from '../src/tools/types.js'
import type { AIToolEvent, AIToolSet, SafeParseSchema } from '../src/tools/types.js'
import { toolDefinitions, validateArgs } from '../src/tools/schema.js'
import type { GenerateInput } from '../src/types.js'

function lastMessage(input: GenerateInput) {
  return input.messages[input.messages.length - 1]
}

/** Model that calls `name(args)` once, then answers with the tool result. */
function callOnce(name: string, args: unknown) {
  return new MockAIProvider({
    reply: (input) => {
      const last = lastMessage(input)
      if (last?.role === 'tool') return `final: ${last.results.map((r) => `${r.isError ? 'ERR ' : ''}${r.content}`).join(' | ')}`
      return { toolCalls: [{ name, args }] }
    },
  })
}

function client(provider: MockAIProvider, tools: AIToolSet, extra: Partial<ConstructorParameters<typeof AIClient>[2]> = {}) {
  const events: AIToolEvent[] = []
  const c = new AIClient(provider, new ContextManager(new MemoryStore()), { tools, onToolEvent: (e) => events.push(e), ...extra })
  return { c, events }
}

describe('tool definitions & validation', () => {
  it('maps JSON Schema tools to provider-neutral definitions', () => {
    const defs = toolDefinitions({
      buscar: { description: 'Busca', schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, handler: () => 'x' },
      hora: { description: 'Hora actual', handler: () => '12:00' },
    })
    expect(defs).toEqual([
      { name: 'buscar', description: 'Busca', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'hora', description: 'Hora actual', parameters: { type: 'object', properties: {} } },
    ])
  })
  it('uses toJSONSchema() of a safeParse validator, or the jsonSchema override, dropping $schema', () => {
    const zodLike = {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
      toJSONSchema: () => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { n: { type: 'number' } } }),
    }
    const [a] = toolDefinitions({ t: { description: 'd', schema: zodLike, handler: () => 1 } })
    expect(a?.parameters).toEqual({ type: 'object', properties: { n: { type: 'number' } } })
    const [b] = toolDefinitions({ t: { description: 'd', schema: zodLike, jsonSchema: { type: 'object', properties: { z: { type: 'string' } } }, handler: () => 1 } })
    expect(b?.parameters).toEqual({ type: 'object', properties: { z: { type: 'string' } } })
  })
  it('validates JSON Schema subset: type, required, enum, additionalProperties, items', () => {
    const tool = {
      description: 'd',
      handler: () => 1,
      schema: {
        type: 'object',
        properties: { q: { type: 'string' }, n: { type: 'integer' }, kind: { enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['q'],
        additionalProperties: false,
      },
    }
    expect(validateArgs(tool, { q: 'x', n: 2, kind: 'a', tags: ['t'] })).toEqual({ ok: true, data: { q: 'x', n: 2, kind: 'a', tags: ['t'] } })
    const bad = validateArgs(tool, { n: 1.5, kind: 'c', tags: [1], extra: true })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error).toMatch(/\$\.q: is required/)
      expect(bad.error).toMatch(/\$\.n: expected integer/)
      expect(bad.error).toMatch(/\$\.kind: must be one of/)
      expect(bad.error).toMatch(/\$\.tags\[0\]: expected string/)
      expect(bad.error).toMatch(/\$\.extra: is not allowed/)
    }
    expect(validateArgs(tool, 'not json').ok).toBe(false)
  })
  it('validates with safeParse and returns the parsed data', () => {
    const schema: SafeParseSchema<{ n: number }> = {
      safeParse: (v) => {
        const n = Number((v as { n?: unknown }).n)
        return Number.isFinite(n) ? { success: true, data: { n } } : { success: false, error: { issues: [{ path: ['n'], message: 'Expected number' }] } }
      },
    }
    const tool = defineTool({ description: 'd', schema, handler: (a) => a.n * 2 })
    expect(validateArgs(tool as never, { n: '3' })).toEqual({ ok: true, data: { n: 3 } })
    expect(validateArgs(tool as never, { n: 'x' })).toEqual({ ok: false, error: 'n: Expected number' })
  })
})

describe('tool loop (AIClient)', () => {
  it('runs a tool call, feeds the result back and returns the final text', async () => {
    const seen: unknown[] = []
    const mock = callOnce('buscar', { q: 'pan' })
    const { c } = client(mock, {
      buscar: { description: 'Busca productos', schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, handler: (args) => { seen.push(args); return [{ sku: 1 }] } },
    })
    expect(await c.ask('¿tienes pan?')).toBe('final: [{"sku":1}]')
    expect(seen).toEqual([{ q: 'pan' }])
    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[0]?.tools).toEqual([{ name: 'buscar', description: 'Busca productos', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }])
    const second = mock.calls[1]!.messages
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    const assistant = second[1]
    expect(assistant?.role === 'assistant' && assistant.toolCalls?.[0]?.name).toBe('buscar')
  })

  it('supports several steps and several calls per step', async () => {
    let step = 0
    const mock = new MockAIProvider({
      reply: () => {
        step++
        if (step === 1) return { toolCalls: [{ name: 'a', args: {} }, { name: 'b', args: {} }] }
        if (step === 2) return { toolCalls: [{ name: 'a', args: {} }] }
        return 'done'
      },
    })
    const ran: string[] = []
    const { c } = client(mock, { a: { description: 'a', handler: () => { ran.push('a'); return 1 } }, b: { description: 'b', handler: () => { ran.push('b'); return 2 } } })
    const r = await c.runTools({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('done')
    expect(r.steps).toBe(3)
    expect(ran).toEqual(['a', 'b', 'a'])
    expect(r.toolResults.map((t) => t.content)).toEqual(['1', '2', '1'])
  })

  it('stops at maxSteps with maxStepsMessage and an audit event', async () => {
    const mock = new MockAIProvider({ reply: { toolCalls: [{ name: 'loop', args: {} }] } })
    let runs = 0
    const { c, events } = client(mock, { loop: { description: 'l', handler: () => { runs++; return 'again' } } }, { maxSteps: 3, maxStepsMessage: 'demasiados pasos' })
    const r = await c.runTools({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('demasiados pasos')
    expect(r.maxStepsReached).toBe(true)
    expect(mock.calls).toHaveLength(3)
    // The last step's calls are never run: the model would not see their results.
    expect(runs).toBe(2)
    expect(r.toolResults).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('loop.max_steps')
  })

  it('does not run (or ask to confirm) tool calls of the last step', async () => {
    const mock = new MockAIProvider({ reply: { toolCalls: [{ name: 'pay', args: {} }] } })
    let runs = 0
    let asked = 0
    const { c } = client(mock, { pay: { description: 'p', confirm: true, handler: () => { runs++; return 'paid' } } }, { maxSteps: 1 })
    const r = await c.runTools({ messages: [{ role: 'user', content: 'x' }] }, { confirm: async () => { asked++; return 'approved' } })
    expect(r.maxStepsReached).toBe(true)
    expect(asked).toBe(0)
    expect(runs).toBe(0)
    expect(r.toolResults).toEqual([])
  })

  it('returns handler errors to the model instead of throwing', async () => {
    const { c, events } = client(callOnce('roto', {}), { roto: { description: 'r', handler: () => { throw new Error('db caída') } } })
    expect(await c.ask('x')).toBe('final: ERR Error: db caída')
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.error'])
    expect(events[1]?.error).toBe('db caída')
  })

  it('times out a slow tool (per-tool timeout) and aborts its signal', async () => {
    let aborted = false
    const { c, events } = client(callOnce('lento', {}), {
      lento: {
        description: 'l',
        timeoutMs: 20,
        handler: (_a, tctx) => new Promise((resolve) => { tctx.signal.addEventListener('abort', () => { aborted = true }); setTimeout(() => resolve('tarde'), 500) }),
      },
    })
    expect(await c.ask('x')).toMatch(/final: ERR Error: Tool "lento" timed out after 20ms/)
    expect(aborted).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.timeout'])
  })

  it('uses the client-wide toolTimeoutMs when the tool has none', async () => {
    const { c } = client(callOnce('lento', {}), { lento: { description: 'l', handler: () => new Promise((r) => setTimeout(() => r('x'), 300)) } }, { toolTimeoutMs: 10 })
    expect(await c.ask('x')).toMatch(/timed out after 10ms/)
  })

  it('reports invalid arguments and unknown tools to the model', async () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    const { c, events } = client(callOnce('buscar', { q: 3 }), { buscar: { description: 'b', schema, handler: () => 'never' } })
    expect(await c.ask('x')).toMatch(/final: ERR Error: invalid arguments for "buscar": \$\.q: expected string/)
    expect(events.map((e) => e.type)).toEqual(['tool.invalid_args'])

    const u = client(callOnce('inventada', {}), { buscar: { description: 'b', handler: () => 'x' } })
    expect(await u.c.ask('x')).toMatch(/final: ERR Error: unknown tool "inventada". Available: buscar/)
    expect(u.events.map((e) => e.type)).toEqual(['tool.unknown'])
  })

  it('does not resolve inherited properties as tools', async () => {
    const { c } = client(callOnce('toString', {}), { buscar: { description: 'b', handler: () => 'x' } })
    expect(await c.ask('x')).toMatch(/unknown tool "toString"/)
  })

  it('denies confirm:true tools when no confirmer is available', async () => {
    let ran = false
    const { c, events } = client(callOnce('borrar', { id: 1 }), { borrar: { description: 'Borra', confirm: true, handler: () => { ran = true } } })
    expect(await c.ask('x')).toMatch(/requires human confirmation/)
    expect(ran).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.confirm.requested', 'tool.confirm.denied'])
  })

  it('asks the confirmer with a rendered prompt; approved runs, denied does not', async () => {
    let ran = 0
    const tools: AIToolSet = {
      borrar: { description: 'Borra un pedido', confirm: true, confirmMessage: (a) => `¿Borro el pedido ${(a as { id: number }).id}?`, handler: () => { ran++; return 'borrado' } },
    }
    const prompts: string[] = []
    const ok = client(callOnce('borrar', { id: 7 }), tools)
    expect(await ok.c.ask('x', { confirm: async (req) => { prompts.push(req.prompt); return 'approved' } })).toBe('final: borrado')
    expect(prompts).toEqual(['¿Borro el pedido 7?'])
    expect(ok.events.map((e) => e.type)).toEqual(['tool.call', 'tool.confirm.requested', 'tool.confirm.approved', 'tool.result'])

    const no = client(callOnce('borrar', { id: 7 }), tools)
    expect(await no.c.ask('x', { confirm: async () => 'denied' })).toMatch(/final: ERR The user declined/)
    expect(ran).toBe(1)
  })

  it('throws AIToolCancelledError when the confirmation is cancelled', async () => {
    const { c } = client(callOnce('borrar', {}), { borrar: { description: 'b', confirm: true, handler: () => 'x' } })
    await expect(c.ask('x', { confirm: async () => 'cancelled' })).rejects.toBeInstanceOf(AIToolCancelledError)
  })

  it('passes ctx, chatKey and callId to handlers; audit events carry chatKey and timing', async () => {
    const seen: Array<{ chatKey?: string; callId: string; tool: string }> = []
    const { c, events } = client(callOnce('t', {}), { t: { description: 't', handler: (_a, tctx) => { seen.push({ chatKey: tctx.chatKey, callId: tctx.callId, tool: tctx.tool }); return 'ok' } } })
    await c.replyInChat('chat-1', 'hola')
    expect(seen).toEqual([{ chatKey: 'chat-1', callId: 'mock_call_1', tool: 't' }])
    expect(events.every((e) => e.chatKey === 'chat-1' && typeof e.at === 'number' && e.step === 1)).toBe(true)
    expect(typeof events.find((e) => e.type === 'tool.result')?.durationMs).toBe('number')
  })

  it('replyInChat persists only the user text and the final answer', async () => {
    const store = new MemoryStore()
    const c = new AIClient(callOnce('t', {}), new ContextManager(store), { tools: { t: { description: 't', handler: () => 'R' } } })
    expect(await c.replyInChat('k', 'hola')).toBe('final: R')
    expect(await store.getConversation('k')).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'final: R' },
    ])
  })

  it('replyInChat aborted mid-turn persists nothing and runs no further tools', async () => {
    const store = new MemoryStore()
    const ctrl = new AbortController()
    let runs = 0
    // The model keeps calling `t`; the first run aborts the turn.
    const mock = new MockAIProvider({ reply: { toolCalls: [{ name: 't', args: {} }] } })
    const c = new AIClient(mock, new ContextManager(store), {
      tools: { t: { description: 't', handler: () => { runs++; ctrl.abort(); return 'R' } } },
    })
    await expect(c.replyInChat('k', 'hola', { signal: ctrl.signal })).rejects.toThrow()
    expect(runs).toBe(1)
    expect(await store.getConversation('k')).toBeUndefined()
  })

  it('a throwing audit sink never breaks the turn', async () => {
    const c = new AIClient(callOnce('t', {}), new ContextManager(new MemoryStore()), {
      tools: { t: { description: 't', handler: () => 'R' } },
      onToolEvent: () => { throw new Error('sink down') },
    })
    expect(await c.ask('x')).toBe('final: R')
  })

  it('without tools, ask/replyInChat behave as before (single call, no tools sent)', async () => {
    const mock = new MockAIProvider({ reply: 'hola' })
    const c = new AIClient(mock, new ContextManager(new MemoryStore()))
    expect(await c.ask('x')).toBe('hola')
    expect(mock.calls[0]?.tools).toBeUndefined()
  })
})
