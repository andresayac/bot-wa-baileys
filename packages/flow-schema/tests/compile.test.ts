import { describe, expect, it } from 'vitest'
import { FLOW_STEP_SOURCE, FlowDocumentError, compileFlowDocument, flowStepSource, type FlowDocument } from '../src/index.js'

const doc = (steps: FlowDocument['steps']): FlowDocument => ({ version: 1, id: 'flow', trigger: 'hola', steps })

/** Minimal stand-ins for the conversation controls and context an action receives. */
function runtime(state: Record<string, unknown> = {}) {
  const replies: any[] = []
  const says: string[] = []
  const calls: string[] = []
  const c = {
    state,
    say: async (text: string) => { says.push(text) },
    ask: async () => 'answer',
    choose: async () => 'a',
    goto: (target: string) => { calls.push(`goto:${target}`); throw new Error('goto') },
    end: (text?: string) => { calls.push(`end:${text ?? ''}`); throw new Error('end') },
  }
  const ctx = {
    body: 'hola', from: 'chat', sender: 'user', isGroup: false,
    reply: async (content: unknown) => { replies.push(content) },
    photo: async (media: unknown, caption?: string) => { replies.push({ kind: 'image', media, ...(caption !== undefined ? { caption } : {}) }) },
    video: async (media: unknown, caption?: string) => { replies.push({ kind: 'video', media, ...(caption !== undefined ? { caption } : {}) }) },
    audio: async (media: unknown) => { replies.push({ kind: 'audio', media }) },
    voice: async (media: unknown) => { replies.push({ kind: 'voice', media }) },
    file: async (media: unknown, filename?: string, caption?: string) => { replies.push({ kind: 'document', media, ...(filename !== undefined ? { filename } : {}), ...(caption !== undefined ? { caption } : {}) }) },
    sticker: async (media: unknown) => { replies.push({ kind: 'sticker', media }) },
    location: async (lat: number, lng: number, name?: string) => { replies.push({ kind: 'location', lat, lng, ...(name !== undefined ? { name } : {}) }) },
    handoff: async (options: { reason?: string }) => { calls.push(`handoff:${options.reason ?? ''}`) },
    tools: {} as Record<string, unknown>,
  }
  return { c, ctx, replies, says, calls }
}

async function runAction(flow: ReturnType<typeof compileFlowDocument>, index: number, state: Record<string, unknown> = {}) {
  const step = flow.steps[index] as { kind: string; fn: (ctx: unknown, c: unknown) => Promise<void> }
  expect(step.kind).toBe('do')
  const r = runtime(state)
  await step.fn(r.ctx, r.c)
  return r
}

describe('compileFlowDocument', () => {
  it('compiles the core steps and keeps the JSON source of each one', () => {
    const flow = compileFlowDocument(doc([
      { kind: 'say', text: 'Hola' },
      { kind: 'ask', text: '¿Nombre?', stateKey: 'name' },
      { kind: 'choose', text: 'Elige', options: [{ key: 'a', label: 'A' }] },
      { kind: 'goto', target: 'other' },
      { kind: 'delay', duration: '2s' },
    ]))
    expect(flow.id).toBe('flow')
    expect(flow.steps.map((step) => step.kind)).toEqual(['say', 'ask', 'choose', 'goto', 'delay'])
    expect((flow.steps[4] as { ms: number }).ms).toBe(2000)
    expect(flowStepSource(flow.steps[0]!)).toEqual({ kind: 'say', text: 'Hola' })
    expect((flow.steps[0] as unknown as Record<symbol, unknown>)[FLOW_STEP_SOURCE]).toBeDefined()
  })

  it('throws FlowDocumentError with issues for an invalid document', () => {
    try {
      compileFlowDocument({ version: 1 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(FlowDocumentError)
      expect((error as FlowDocumentError).issues.length).toBeGreaterThan(0)
    }
  })

  it('compiles media as a top-level media step', () => {
    const flow = compileFlowDocument(doc([{ kind: 'media', type: 'image', source: { url: 'https://example.com/a.png' }, caption: 'Menú' }]))
    expect(flow.steps[0]).toMatchObject({ kind: 'media', type: 'image', source: 'https://example.com/a.png', caption: 'Menú' })
  })

  it('runs nested media, guard, condition, http, handoff and ai steps', async () => {
    // media (nested, so the interpreter runs it)
    const mediaFlow = compileFlowDocument(doc([{
      kind: 'condition', if: 'true', then: [{ kind: 'media', type: 'document', source: { url: 'https://example.com/f.pdf' }, filename: 'f.pdf' }],
    }]))
    expect((await runAction(mediaFlow, 0)).replies).toEqual([{ kind: 'document', media: { url: 'https://example.com/f.pdf' }, filename: 'f.pdf' }])

    // guard (failed: message + redirect); the core interpreter runs the compiled guard step
    const guardFlow = compileFlowDocument(doc([{ kind: 'guard', if: 'age >= 18', message: 'Solo adultos', redirect: 'adult' }]))
    const guard = guardFlow.steps[0] as { kind: string; check: (ctx: unknown, c: unknown) => boolean }
    expect(guard.kind).toBe('guard')
    expect(guard.check(runtime({ age: 15 }).ctx, runtime({ age: 15 }).c)).toBe(false)
    expect(guard.check(runtime({ age: 21 }).ctx, runtime({ age: 21 }).c)).toBe(true)

    // condition
    const conditionFlow = compileFlowDocument(doc([{ kind: 'condition', if: 'n > 1', then: [{ kind: 'say', text: 'grande' }], else: [{ kind: 'say', text: 'pequeño' }] }]))
    expect((await runAction(conditionFlow, 0, { n: 2 })).says).toEqual(['grande'])
    expect((await runAction(conditionFlow, 0, { n: 0 })).says).toEqual(['pequeño'])

    // http with an injected fetch
    const seen: Array<{ url: string; options: any }> = []
    const httpFlow = compileFlowDocument(doc([{ kind: 'http', method: 'POST', url: 'https://api.example.com/{{id}}', headers: { Authorization: 'Bearer {{token}}' }, body: { n: 1 }, stateKey: 'result' }]), {
      fetch: async (url, options) => {
        seen.push({ url, options })
        return { url: new URL(url), response: new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }), body: Buffer.from('{"ok":true}') }
      },
    })
    const http = await runAction(httpFlow, 0, { id: '42', token: 't' })
    expect(seen[0]!.url).toBe('https://api.example.com/42')
    expect(seen[0]!.options.headers).toEqual({ Authorization: 'Bearer t' })
    expect(http.c.state.result).toEqual({ ok: true })

    // ai with the injected client
    const aiFlow = compileFlowDocument(doc([{ kind: 'ai', prompt: 'Resume {{text}}', tools: ['lookup'], stateKey: 'summary' }]))
    const aiRuntime = runtime({ text: 'esto' })
    aiRuntime.ctx.tools.ai = { replyInChat: async (chat: string, prompt: string, options: any) => {
      expect(chat).toBe('chat')
      expect(prompt).toBe('Resume esto')
      expect(options).toMatchObject({ userId: 'user', isGroup: false, tools: ['lookup'] })
      return 'resumen'
    } }
    await (aiFlow.steps[0] as any).fn(aiRuntime.ctx, aiRuntime.c)
    expect(aiRuntime.c.state.summary).toBe('resumen')

    // handoff (c.end throws in this fake, like the runtime's control signal)
    const handoffFlow = compileFlowDocument(doc([{ kind: 'handoff', reason: 'billing', message: 'Te paso' }]))
    const handoffRuntime = runtime()
    await (handoffFlow.steps[0] as any).fn(handoffRuntime.ctx, handoffRuntime.c).catch(() => {})
    expect(handoffRuntime.calls).toEqual(['handoff:billing', 'end:'])
    expect(handoffRuntime.says).toEqual(['Te paso'])
  })

  it('inlines a resolved subflow and rejects missing ones and cycles', () => {
    const child: FlowDocument = { version: 1, id: 'child', trigger: 'child', steps: [{ kind: 'say', text: 'hijo' }] }
    const parent = doc([{ kind: 'subflow', flowId: 'child' }])
    const flow = compileFlowDocument(parent, { resolveSubflow: (id) => (id === 'child' ? child : undefined) })
    expect(flow.steps[0]).toMatchObject({ kind: 'use', flow: { id: 'child' } })
    expect(() => compileFlowDocument(parent)).toThrow(/cannot be resolved/)
    expect(() => compileFlowDocument(doc([{ kind: 'subflow', flowId: 'flow' }]), {
      resolveSubflow: () => ({ version: 1, id: 'flow', trigger: 'x', steps: [{ kind: 'say', text: 'x' }] }),
    })).toThrow(/cycle/)
  })
})
