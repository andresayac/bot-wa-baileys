import { describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import { RateLimitedError } from '../src/core/provider.js'
import type { BotConfig } from '../src/core/types.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createRecordingTracer, type RecordedSpan } from '../src/testing/recordingTracer.js'
import { NOOP_TRACING, TRACE_ATTR, noopTracer, type BotSpan, type BotTracer } from '../src/index.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { definePlugin } from '../src/plugins/definePlugin.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

async function setup(config: Omit<BotConfig, 'provider'> = {}, providerOptions?: ConstructorParameters<typeof MockProvider>[0]) {
  const provider = new MockProvider(providerOptions)
  const bot = new Bot({ ...config, provider })
  bot.on('error', () => {})
  await bot.start()
  return { bot, provider }
}

async function tracedBot(config: Omit<BotConfig, 'provider' | 'telemetry'> = {}, telemetry: Partial<NonNullable<BotConfig['telemetry']>> = {}) {
  const rec = createRecordingTracer()
  const { bot, provider } = await setup({ ...config, telemetry: { tracer: rec.tracer, ids: 'raw', ...telemetry } })
  return { rec, bot, provider }
}

const chain = (rec: ReturnType<typeof createRecordingTracer>, span: RecordedSpan): string[] => {
  const names: string[] = []
  for (let s: RecordedSpan | undefined = span; s; s = rec.parentOf(s)) names.unshift(s.name)
  return names
}

describe('telemetry: disabled by default', () => {
  it('a bot without telemetry exposes a disabled no-op tracing', async () => {
    const { bot } = await setup()
    expect(bot.tracing).toBe(NOOP_TRACING)
    expect(bot.tracing.enabled).toBe(false)
    const span = bot.tracing.startSpan('x')
    expect(span.isRecording()).toBe(false)
    expect(bot.tracing.trace('x', {}, () => 42)).toBe(42)
    expect(bot.tracing.activeSpan()).toBeUndefined()
    expect(noopTracer.startSpan('y').isRecording()).toBe(false)
    await bot.stop()
  })

  it('validates telemetry.tracer and telemetry.ids', () => {
    const provider = new MockProvider()
    expect(() => new Bot({ provider, telemetry: {} as never })).toThrow(/telemetry\.tracer/)
    expect(() => new Bot({ provider, telemetry: { tracer: noopTracer, ids: 'plain' as never } })).toThrow(/telemetry\.ids/)
    expect(() => new Bot({ provider, telemetry: { tracer: noopTracer, idKey: 3 as never } })).toThrow(/telemetry\.idKey/)
  })
})

describe('telemetry: inbound → dispatch → handler → send', () => {
  it('builds the span tree with the expected parents and attributes', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    provider.incoming('hola', { from: 'u1', id: 'm1' })
    await tick()

    const inbound = rec.find('bot.inbound')!
    expect(inbound.kind).toBe('consumer')
    expect(inbound.parentId).toBeUndefined()
    expect(inbound.attributes).toMatchObject({
      [TRACE_ATTR.providerId]: 'mock',
      [TRACE_ATTR.eventKind]: 'message',
      [TRACE_ATTR.messageType]: 'text',
      [TRACE_ATTR.chatKind]: 'private',
      [TRACE_ATTR.chatId]: 'u1',
      [TRACE_ATTR.senderId]: 'u1',
      [TRACE_ATTR.messageId]: 'm1',
      [TRACE_ATTR.inboundOutcome]: 'dispatched',
    })
    expect(rec.parentOf(rec.find('bot.persist')!)?.name).toBe('bot.inbound')
    const dispatch = rec.find('bot.dispatch')!
    expect(rec.parentOf(dispatch)).toBe(inbound)
    expect(dispatch.attributes[TRACE_ATTR.dispatchStage]).toBe('matcher')
    expect(typeof dispatch.attributes[TRACE_ATTR.queueWaitMs]).toBe('number')
    const handler = rec.find('bot.handler')!
    expect(rec.parentOf(handler)).toBe(dispatch)
    expect(handler.attributes).toMatchObject({ [TRACE_ATTR.handlerStage]: 'matcher', [TRACE_ATTR.matcherKind]: 'text' })
    const send = rec.find('bot.send')!
    expect(chain(rec, send)).toEqual(['bot.inbound', 'bot.dispatch', 'bot.handler', 'bot.pace', 'bot.send'])
    expect(send.kind).toBe('client')
    expect(send.attributes).toMatchObject({
      [TRACE_ATTR.contentKind]: 'text', [TRACE_ATTR.sendOrigin]: 'ctx', [TRACE_ATTR.sendOutcome]: 'ok', [TRACE_ATTR.chatId]: 'u1',
    })
    expect(typeof rec.find('bot.pace')!.attributes[TRACE_ATTR.paceMs]).toBe('number')
    // Every span ended, children before parents.
    for (const s of rec.spans) expect(s.ended, s.name).toBe(true)
    expect(send.endOrder!).toBeLessThan(handler.endOrder!)
    expect(handler.endOrder!).toBeLessThan(dispatch.endOrder!)
    expect(dispatch.endOrder!).toBeLessThan(inbound.endOrder!)
    await bot.stop()
  })

  it('spans.persist / spans.pace false drop those spans', async () => {
    const { rec, bot, provider } = await tracedBot({}, { spans: { persist: false, pace: false } })
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(rec.find('bot.persist')).toBeUndefined()
    expect(rec.find('bot.pace')).toBeUndefined()
    expect(chain(rec, rec.find('bot.send')!)).toEqual(['bot.inbound', 'bot.dispatch', 'bot.handler', 'bot.send'])
    await bot.stop()
  })

  it('a user span inside a handler nests under bot.handler (bot.tracing)', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.when('hola', async () => {
      await bot.tracing.trace('erp.lookup', {}, async () => { await tick(1) })
    })
    provider.incoming('hola', { from: 'u1' })
    await tick()
    const own = rec.find('erp.lookup')!
    expect(rec.parentOf(own)?.name).toBe('bot.handler')
    expect(own.ended).toBe(true)
    await bot.stop()
  })

  it('bot.send from outside any message is a root span with origin api', async () => {
    const { rec, bot } = await tracedBot()
    await bot.send('u9', 'hola')
    const send = rec.find('bot.send')!
    expect(send.parentId).toBeUndefined()
    expect(send.attributes[TRACE_ATTR.sendOrigin]).toBe('api')
    await bot.stop()
  })

  it('commands, catch-all and unknown commands', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.command('menu', async () => {})
    bot.onMessage(async () => {})
    provider.incoming('/menu extra', { from: 'a' })
    provider.incoming('/secretcommand 1234', { from: 'b' })
    provider.incoming('cualquier cosa', { from: 'c' })
    await tick()
    const stageOf = (chat: string) => rec.find('bot.dispatch', (s) => rec.parentOf(s)?.attributes[TRACE_ATTR.chatId] === chat)!
      .attributes[TRACE_ATTR.dispatchStage]
    expect(stageOf('a')).toBe('command')
    expect(stageOf('b')).toBe('catch_all')
    expect(stageOf('c')).toBe('catch_all')
    const cmd = rec.find('bot.handler', (s) => s.attributes[TRACE_ATTR.handlerStage] === 'command')!
    expect(cmd.attributes[TRACE_ATTR.commandName]).toBe('menu')
    expect(rec.allValues().some((v) => v.includes('secretcommand'))).toBe(false)
    await bot.stop()
  })

  it('flow entry matchers carry bot.flow.id', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.use(flow('registro').say('hola'))
    provider.incoming('registro', { from: 'u1' })
    await tick()
    expect(rec.find('bot.handler')!.attributes[TRACE_ATTR.flowId]).toBe('registro')
    await bot.stop()
  })
})

describe('telemetry: inbound outcomes', () => {
  it('blocked, duplicate, group_filtered, handoff and stopped', async () => {
    const { rec, bot, provider } = await tracedBot({ groupMode: 'commands' })
    bot.onMessage(async () => {})
    bot.blacklist.add('bad')
    provider.incoming('hola', { from: 'bad' })
    provider.incoming('uno', { from: 'u1', id: 'dup' })
    provider.incoming('uno', { from: 'u1', id: 'dup' })
    provider.incoming('hola grupo', { from: 'g1', sender: 'p1', isGroup: true })
    await tick()
    await bot.handoff('h1')
    provider.incoming('ayuda', { from: 'h1' })
    await tick()
    const outcomes = rec.findAll('bot.inbound').map((s) => [s.attributes[TRACE_ATTR.chatId], s.attributes[TRACE_ATTR.inboundOutcome]])
    expect(outcomes).toEqual([
      ['bad', 'blocked'],
      ['u1', 'dispatched'],
      ['u1', 'duplicate'],
      ['g1', 'group_filtered'],
      ['h1', 'dispatched'],
    ])
    const handoff = rec.find('bot.dispatch', (s) => rec.parentOf(s)?.attributes[TRACE_ATTR.chatId] === 'h1')!
    expect(handoff.attributes[TRACE_ATTR.dispatchStage]).toBe('handoff')
    await bot.stop()
    provider.incoming('tarde', { from: 'u2' })
    await tick()
    expect(rec.findAll('bot.inbound').at(-1)!.attributes[TRACE_ATTR.inboundOutcome]).toBe('stopped')
  })

  it('a call gets an inbound span; connection events do not', async () => {
    const { rec, bot, provider } = await tracedBot()
    provider.call({ id: 'c1', from: 'u1', status: 'offer' })
    await tick()
    const spans = rec.findAll('bot.inbound')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes).toMatchObject({ [TRACE_ATTR.eventKind]: 'call', [TRACE_ATTR.messageType]: 'call' })
    await bot.stop()
  })
})

describe('telemetry: personal data', () => {
  const BODY = 'mi cédula es 1032456789 y vivo en calle 5'

  it('never records the message body (hash, raw or omit)', async () => {
    for (const ids of ['hash', 'raw', 'omit'] as const) {
      const { rec, bot, provider } = await tracedBot({}, { ids })
      bot.when(() => true, async (ctx) => { await ctx.reply(`eco: ${ctx.body}`) })
      provider.incoming(BODY, { from: 'u1' })
      await tick()
      expect(rec.spans.length).toBeGreaterThan(3)
      for (const v of rec.allValues()) {
        expect(v).not.toContain('1032456789')
        expect(v).not.toContain('calle 5')
      }
      await bot.stop()
    }
  })

  it("ids: 'hash' is a stable 16-char HMAC per idKey, 'omit' drops the ids", async () => {
    const hashOf = async (telemetry: Partial<NonNullable<BotConfig['telemetry']>>) => {
      const { rec, bot, provider } = await tracedBot({}, telemetry)
      provider.incoming('hola', { from: '573001112233' })
      await tick()
      await bot.stop()
      return rec.find('bot.inbound')!.attributes[TRACE_ATTR.chatId]
    }
    const a = await hashOf({ ids: 'hash', idKey: 'k1' })
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(a).not.toContain('573001112233')
    expect(await hashOf({ ids: 'hash', idKey: 'k1' })).toBe(a)
    expect(await hashOf({ ids: 'hash', idKey: 'k2' })).not.toBe(a)
    expect(await hashOf({ ids: 'hash', idKey: new TextEncoder().encode('k1') })).toBe(a)
    expect(await hashOf({ ids: 'omit' })).toBeUndefined()
  })

  it('sampled-out spans skip id hashing', async () => {
    const rec = createRecordingTracer({ sampled: false })
    const { bot, provider } = await setup({ telemetry: { tracer: rec.tracer } })
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(rec.find('bot.inbound')!.attributes[TRACE_ATTR.chatId]).toBeUndefined()
    await bot.stop()
  })

  it('error messages are recorded only with errorMessages', async () => {
    for (const errorMessages of [false, true]) {
      const { rec, bot, provider } = await tracedBot({}, { errorMessages })
      bot.when('x', () => { throw new Error('secret 999') })
      provider.incoming('x', { from: 'u1' })
      await tick()
      const handler = rec.find('bot.handler')!
      expect(handler.status.code).toBe('error')
      expect(handler.attributes[TRACE_ATTR.errorType]).toBe('Error')
      expect(rec.allValues().some((v) => v.includes('secret 999'))).toBe(errorMessages)
      await bot.stop()
    }
  })
})

describe('telemetry: sends', () => {
  it('a failed send records error.type and outcome failed', async () => {
    const { rec, bot, provider } = await tracedBot()
    vi.spyOn(provider, 'send').mockRejectedValueOnce(new RateLimitedError(1000, 'slow down'))
    await expect(bot.send('u1', 'hola')).rejects.toBeInstanceOf(RateLimitedError)
    const send = rec.find('bot.send')!
    expect(send.status.code).toBe('error')
    expect(send.attributes).toMatchObject({ [TRACE_ATTR.sendOutcome]: 'failed', [TRACE_ATTR.errorType]: 'RateLimitedError' })
    expect(send.exceptions).toEqual([{ name: 'RateLimitedError' }])
    await bot.stop()
  })

  it('a before(send) abort is outcome skipped; a durable repeat is deduplicated', async () => {
    const { rec, bot } = await tracedBot({ durability: {} })
    await bot.send('u1', 'uno', { idempotencyKey: 'k1' })
    await bot.send('u1', 'uno', { idempotencyKey: 'k1' })
    bot.before('send', (p) => { p.abort() })
    await bot.send('u1', 'dos')
    expect(rec.findAll('bot.send').map((s) => s.attributes[TRACE_ATTR.sendOutcome])).toEqual(['ok', 'deduplicated', 'skipped'])
    await bot.stop()
  })

  it('edits are bot.send spans with bot.send.edit', async () => {
    const rec = createRecordingTracer()
    const { bot, provider } = await setup({ telemetry: { tracer: rec.tracer } }, { supports: { edit: true } })
    bot.when('hola', async (ctx) => { await ctx.reply('uno'); await ctx.edit('dos') })
    provider.incoming('hola', { from: 'u1' })
    await tick()
    const edit = rec.find('bot.send', (s) => s.attributes[TRACE_ATTR.sendEdit] === true)!
    expect(edit.attributes[TRACE_ATTR.sendOutcome]).toBe('ok')
    expect(rec.parentOf(edit)?.name).toBe('bot.handler')
    await bot.stop()
  })

  it('broadcast and trigger spans', async () => {
    const { rec, bot } = await tracedBot()
    bot.conversation('aviso', async (c) => { await c.say('hola') }, { trigger: '__never__' })
    await bot.broadcast(['a', 'b'], 'promo')
    const broadcast = rec.find('bot.broadcast')!
    expect(broadcast.attributes[TRACE_ATTR.broadcastRecipients]).toBe(2)
    expect(rec.childrenOf(broadcast).map((s) => s.name)).toEqual(['bot.send', 'bot.send'])
    await bot.trigger('aviso', { chatId: 'c1' })
    await tick()
    const trigger = rec.find('bot.trigger')!
    expect(trigger.attributes).toMatchObject({ [TRACE_ATTR.triggerName]: 'aviso', [TRACE_ATTR.triggerResult]: 'started' })
    const turn = rec.find('bot.conversation.turn')!
    expect(rec.parentOf(turn)).toBe(trigger)
    await bot.stop()
  })
})

describe('telemetry: fault isolation and equivalence', () => {
  it('a tracer that throws on every call never breaks the bot; the warning is logged once', async () => {
    const throwingSpan: BotSpan = new Proxy({} as BotSpan, { get: () => () => { throw new Error('span boom') } })
    const tracers: BotTracer[] = [
      { startSpan: () => { throw new Error('boom') } },
      { startSpan: () => throwingSpan, withSpan: () => { throw new Error('ctx boom') } },
    ]
    for (const tracer of tracers) {
      const warn = vi.fn()
      const logger = { warn, debug() {}, info() {}, error() {}, child() { return logger } }
      const { bot, provider } = await setup({ telemetry: { tracer }, logger: logger as never })
      bot.when('hola', async (ctx) => { await ctx.reply('👋') })
      provider.incoming('hola', { from: 'u1' })
      provider.incoming('hola', { from: 'u2' })
      await tick()
      expect(provider.outbox.map((o) => o.chatId)).toEqual(['u1', 'u2'])
      expect(warn.mock.calls.filter((c) => c[1] === 'tracer call failed (telemetry ignored)')).toHaveLength(1)
      await bot.stop()
    }
  })

  it('the same traffic produces the same outbox with and without tracing', async () => {
    const run = async (telemetry: boolean) => {
      const rec = createRecordingTracer()
      const { bot, provider } = await setup(telemetry ? { telemetry: { tracer: rec.tracer } } : {})
      bot.use(flow('pedido').ask('¿qué quieres?', 'item').ask('¿cuántos?', 'qty').say((ctx) => `listo ${ctx.body}`))
      bot.command('ping', async (ctx) => { await ctx.reply('pong') })
      bot.onMessage(async (ctx) => { await ctx.reply(`eco ${ctx.body}`) })
      for (const [from, text] of [['a', 'pedido'], ['b', 'hola'], ['a', 'pan'], ['b', '/ping'], ['a', '3'], ['c', 'x']]) {
        provider.incoming(text!, { from })
      }
      await tick(60)
      await bot.stop()
      return provider.outbox.map((o) => `${o.chatId}:${o.content.kind === 'text' ? o.content.text : o.content.kind}`)
    }
    expect(await run(true)).toEqual(await run(false))
  })

  it('a plugin-scoped bot sees the same tracing object', async () => {
    const { bot } = await tracedBot()
    let seen: unknown
    bot.plug(definePlugin({ name: 'p', version: '1.0.0', install(ctx) { seen = ctx.bot.tracing } }))
    expect(seen).toBe(bot.tracing)
    expect(bot.tracing.enabled).toBe(true)
    await bot.stop()
  })

  it('bot.tracing.idAttribute applies the ids policy', async () => {
    const { bot } = await tracedBot({}, { ids: 'omit' })
    expect(bot.tracing.idAttribute('u1')).toBeUndefined()
    await bot.stop()
  })
})

