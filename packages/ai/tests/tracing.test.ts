import { describe, expect, it } from 'vitest'
import { MemoryStore, NOOP_TRACING, TRACE_ATTR, type BotTracing } from '@bot-wa/core'
import { createRecordingTracer, createTestBot, type RecordingTracer } from '@bot-wa/core/testing'

import { aiPlugin } from '../src/plugin.js'
import { AIClient } from '../src/AIClient.js'
import { ContextManager } from '../src/ContextManager.js'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { defineTool, type AIToolSet } from '../src/tools/types.js'
import type { AIProvider, GenerateInput, GenerateResult } from '../src/types.js'

const SECRET = 'mi tarjeta 4111111111111111'

/** A provider reporting usage and a stop reason (generate and stream). */
class UsageProvider implements AIProvider {
  readonly name = 'acme'
  constructor(private readonly reply: (input: GenerateInput) => Partial<GenerateResult> = () => ({ text: 'respuesta privada' })) {}
  async generate(input: GenerateInput): Promise<GenerateResult> {
    const r = this.reply(input)
    return { text: '', model: 'acme-1-2026', usage: { input: 12, output: 7 }, stopReason: 'end_turn', ...r }
  }
  async *stream(input: GenerateInput): AsyncIterable<string> {
    for (const piece of ['res', 'puesta ', 'privada']) yield piece
    input.onStreamEnd?.({ stopReason: 'end_turn', usage: { input: 5, output: 3 } })
  }
}

async function tracedBot() {
  const rec = createRecordingTracer()
  const t = await createTestBot({ telemetry: { tracer: rec.tracer } })
  return { rec, ...t }
}

/** An AIClient on a traced bot's tracing; `run` executes inside a parent span. */
async function tracedClient(provider: AIProvider, opts: ConstructorParameters<typeof AIClient>[2] = {}) {
  const { rec, bot } = await tracedBot()
  const client = new AIClient(provider, new ContextManager(new MemoryStore({})), { tracing: bot.tracing, ...opts })
  const run = <T>(fn: () => Promise<T>): Promise<T> => bot.tracing.trace('test', {}, fn)
  return { rec, bot, client, run }
}

function noSecrets(rec: RecordingTracer): void {
  for (const v of rec.allValues()) {
    expect(v).not.toContain('4111')
    expect(v).not.toContain('privada')
  }
}

describe('@bot-wa/ai tracing', () => {
  it('the autoreply model call is a chat span under the handler, with GenAI attributes and no text', async () => {
    const { rec, bot, chat } = await tracedBot()
    bot.plug(aiPlugin({ __provider: new UsageProvider(), humanizeTyping: false, model: 'acme-1' }))
    await chat.send(SECRET)
    await chat.expectReply('respuesta privada')
    const span = rec.find('chat acme-1')!
    expect(span.kind).toBe('client')
    expect(rec.parentOf(span)?.name).toBe('bot.handler')
    expect(span.attributes).toMatchObject({
      [TRACE_ATTR.genAiOperation]: 'chat',
      [TRACE_ATTR.genAiProvider]: 'acme',
      [TRACE_ATTR.genAiRequestModel]: 'acme-1',
      [TRACE_ATTR.genAiResponseModel]: 'acme-1-2026',
      [TRACE_ATTR.genAiInputTokens]: 12,
      [TRACE_ATTR.genAiOutputTokens]: 7,
      [TRACE_ATTR.genAiFinishReasons]: ['end_turn'],
      [TRACE_ATTR.aiPurpose]: 'reply',
    })
    expect(span.ended).toBe(true)
    // The reply goes out after the model span ended, under the same handler.
    const send = rec.find('bot.send')!
    expect(rec.parentOf(rec.parentOf(send)!)?.name).toBe('bot.handler')
    noSecrets(rec)
    await bot.stop()
  })

  it('ask / generate / memory purposes, and a refusal keeps the status unset', async () => {
    const { rec, client, run } = await tracedClient(new UsageProvider(() => ({ text: 'no', stopReason: 'refusal' })))
    await run(() => client.ask(SECRET))
    await run(() => client.generate({ messages: [{ role: 'user', content: SECRET }] }))
    const spans = rec.findAll('chat')
    expect(spans.map((s) => s.attributes[TRACE_ATTR.aiPurpose])).toEqual(['ask', 'generate'])
    expect(spans[0]!.attributes[TRACE_ATTR.genAiFinishReasons]).toEqual(['refusal'])
    expect(spans[0]!.status.code).toBe('unset')
    expect(rec.parentOf(spans[0]!)?.name).toBe('test')
    noSecrets(rec)
  })

  it('a timeout is status error with error.type timeout', async () => {
    const hang: AIProvider = { name: 'slow', generate: () => new Promise(() => {}), stream: async function* () {} }
    const { rec, client, run } = await tracedClient(hang, { timeoutMs: 20 })
    await expect(run(() => client.ask('hola'))).rejects.toThrow(/timed out/)
    const span = rec.find('chat')!
    expect(span.status.code).toBe('error')
    expect(span.attributes[TRACE_ATTR.errorType]).toBe('timeout')
    expect(span.ended).toBe(true)
  })

  it('tool loop: one chat span per step and an execute_tool span per call with its outcome', async () => {
    let runs = 0
    const tools: AIToolSet = {
      ok: defineTool({ description: 'ok', handler: () => ({ done: SECRET }) }),
      boom: defineTool({ description: 'boom', handler: () => { throw new Error(SECRET) } }),
      slow: defineTool({ description: 'slow', timeoutMs: 10, handler: () => new Promise(() => {}) }),
      typed: defineTool({ description: 'typed', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }, handler: () => 1 }),
      guarded: defineTool({ description: 'guarded', confirm: true, handler: () => 1 }),
      once: defineTool({ description: 'once', dedupe: 'args', handler: () => { runs++; return 'x' } }),
    }
    const calls = [
      { id: 'c1', name: 'ok', args: { secret: SECRET } },
      { id: 'c2', name: 'boom' },
      { id: 'c3', name: 'slow' },
      { id: 'c4', name: 'typed', args: { n: 'no' } },
      { id: 'c5', name: 'missing' },
      { id: 'c6', name: 'guarded' },
      { id: 'c7', name: 'once' },
      { id: 'c8', name: 'once' },
    ]
    const provider = new MockAIProvider({
      reply: (input) => (input.messages.at(-1)?.role === 'tool' ? 'listo' : { toolCalls: calls }),
    })
    const { rec, client, run } = await tracedClient(provider, { tools })
    const r = await run(() => client.runTools({ messages: [{ role: 'user', content: 'go' }] }, { chatKey: 'k' }))
    expect(r.text).toBe('listo')
    expect(runs).toBe(1)
    const steps = rec.findAll('chat')
    expect(steps.map((s) => s.attributes[TRACE_ATTR.aiStep])).toEqual([1, 2])
    expect(steps.every((s) => s.attributes[TRACE_ATTR.aiPurpose] === 'tool_step')).toBe(true)
    const tool = (id: string) => rec.spans.find((s) => s.attributes[TRACE_ATTR.genAiToolCallId] === id)!
    const outcomes = calls.map((c) => [c.id, tool(c.id).attributes[TRACE_ATTR.aiToolOutcome]])
    expect(outcomes).toEqual([
      ['c1', 'ok'], ['c2', 'error'], ['c3', 'timeout'], ['c4', 'invalid_args'],
      ['c5', 'unknown'], ['c6', 'confirm.denied'], ['c7', 'ok'], ['c8', 'duplicate'],
    ])
    expect(tool('c1').name).toBe('execute_tool ok')
    expect(tool('c1').attributes).toMatchObject({ [TRACE_ATTR.genAiOperation]: 'execute_tool', [TRACE_ATTR.genAiToolName]: 'ok' })
    expect(tool('c2').status.code).toBe('error')
    expect(tool('c3').attributes[TRACE_ATTR.errorType]).toBe('timeout')
    expect(tool('c6').events.map((e) => e.name)).toEqual(['confirm.requested'])
    expect(rec.parentOf(tool('c1'))?.name).toBe('test')
    for (const s of rec.spans) expect(s.ended, s.name).toBe(true)
    noSecrets(rec)
  })

  it('a cancelled confirmation ends its tool span with outcome confirm.cancelled', async () => {
    const tools: AIToolSet = { guarded: defineTool({ description: 'guarded', confirm: true, handler: () => 1 }) }
    const provider = new MockAIProvider({ reply: { toolCalls: [{ id: 'g1', name: 'guarded' }] } })
    const { rec, client, run } = await tracedClient(provider, { tools })
    await expect(run(() => client.runTools({ messages: [{ role: 'user', content: 'go' }] }, { confirm: async () => 'cancelled' })))
      .rejects.toThrow()
    const span = rec.find('execute_tool guarded')!
    expect(span.attributes[TRACE_ATTR.aiToolOutcome]).toBe('confirm.cancelled')
    expect(span.ended).toBe(true)
  })

  it('streamReplyInChat: one streamed chat span with usage; an early return marks it cancelled', async () => {
    const { rec, client, run } = await tracedClient(new UsageProvider())
    await run(async () => { for await (const _ of client.streamReplyInChat('k', SECRET)) { /* drain */ } })
    const full = rec.find('chat')!
    expect(full.attributes).toMatchObject({
      [TRACE_ATTR.aiStreamed]: true, [TRACE_ATTR.aiPurpose]: 'reply',
      [TRACE_ATTR.genAiInputTokens]: 5, [TRACE_ATTR.genAiOutputTokens]: 3, [TRACE_ATTR.genAiFinishReasons]: ['end_turn'],
    })
    expect(full.attributes[TRACE_ATTR.aiCancelled]).toBeUndefined()
    expect(full.ended).toBe(true)

    rec.reset()
    await run(async () => {
      const it = client.streamReplyInChat('k2', 'hola')
      await it.next()
      await it.return?.()
    })
    const cut = rec.find('chat')!
    expect(cut.attributes[TRACE_ATTR.aiCancelled]).toBe(true)
    expect(cut.ended).toBe(true)
    noSecrets(rec)
  })

  it('stream(): the span starts at the first next() and ends when the stream does', async () => {
    const { rec, client, run } = await tracedClient(new UsageProvider())
    const stream = client.stream({ messages: [{ role: 'user', content: SECRET }] })
    expect(rec.find('chat')).toBeUndefined()
    let ended: unknown
    await run(async () => {
      for await (const _ of client.stream({ messages: [{ role: 'user', content: 'x' }], onStreamEnd: (i) => { ended = i } })) { /* drain */ }
    })
    expect(ended).toEqual({ stopReason: 'end_turn', usage: { input: 5, output: 3 } })
    const span = rec.find('chat')!
    expect(span.attributes).toMatchObject({ [TRACE_ATTR.aiPurpose]: 'generate', [TRACE_ATTR.genAiOutputTokens]: 3 })
    expect(span.ended).toBe(true)
    void stream
  })

  it('RAG retrieval is a bot.ai.retrieve span with the chunk count', async () => {
    const retriever = { retrieve: async () => [{ text: 'a' }, { text: 'b' }] }
    const { rec, client, run } = await tracedClient(new UsageProvider(), { rag: { retriever } })
    await run(() => client.replyInChat('k', 'hola'))
    const span = rec.find('bot.ai.retrieve')!
    expect(span.attributes[TRACE_ATTR.aiRagChunks]).toBe(2)
    expect(rec.parentOf(span)?.name).toBe('test')
  })

  it('without tracing (or a disabled one) nothing changes', async () => {
    for (const tracing of [undefined, NOOP_TRACING as BotTracing]) {
      const provider = new MockAIProvider({ reply: 'hola' })
      const client = new AIClient(provider, new ContextManager(new MemoryStore({})), tracing ? { tracing } : {})
      expect(await client.ask('x')).toBe('hola')
      const chunks: string[] = []
      for await (const c of client.stream({ messages: [{ role: 'user', content: 'x' }] })) chunks.push(c)
      expect(chunks.join('')).toBe('hola')
    }
  })
})
