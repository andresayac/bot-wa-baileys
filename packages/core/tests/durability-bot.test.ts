/** Durable message processing wired into the Bot (BotConfig.durability). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Bot, MemoryDurability, MemoryStore, RateLimitedError, SendDeferredError, UnsupportedContentError, flow,
  type BotConfig, type OutboundContent, type SendOptions, type SendResult,
} from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'

class FlakyProvider extends MockProvider {
  /** Errors thrown by the next sends, in order (`undefined` = succeed). */
  failures: unknown[] = []
  calls = 0
  override async send(chatId: string, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    this.calls++
    const failure = this.failures.shift()
    if (failure !== undefined) throw failure
    return super.send(chatId, content, options)
  }
}

const bots: Bot[] = []
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => {})
  vi.useRealTimers()
})

async function makeBot(config: Partial<BotConfig> = {}, provider = new FlakyProvider()) {
  const bot = new Bot({ provider, logger: silent(), ...config })
  bots.push(bot)
  await bot.start()
  return { bot, provider }
}

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind))

describe('durability off (default)', () => {
  it('exposes nothing and keeps the old send path', async () => {
    const { bot, provider } = await makeBot()
    expect(bot.durability).toBeUndefined()
    await expect(bot.enqueue('c', 'x')).rejects.toThrow(/needs BotConfig.durability/)
    await bot.send('c1', 'hola', { idempotencyKey: 'k' })
    expect(provider.outbox[0].options).toEqual({ idempotencyKey: 'k' }) // passed through untouched
  })

  it('send order is identical with and without durability', async () => {
    const run = async (config: Partial<BotConfig>) => {
      const { bot, provider } = await makeBot(config)
      bot.when('hola', async (ctx) => { await ctx.reply('a'); await ctx.reply('b') })
      bot.onMessage(async (ctx) => { await ctx.reply(`echo ${ctx.body}`) })
      for (const body of ['hola', 'x', 'hola', 'y']) provider.incoming(body, { from: 'u1' })
      await vi.waitFor(() => expect(provider.outbox.length).toBe(6))
      return texts(provider)
    }
    expect(await run({ durability: {} })).toEqual(await run({}))
  })
})

describe('durability on', () => {
  it('journals the inbound, keys its reply by the record and acks it', async () => {
    const { bot, provider } = await makeBot({ durability: {} })
    bot.when('hola', async (ctx) => { await ctx.reply('hi') })
    provider.incoming('hola', { from: 'u1', id: 'm1' })
    await vi.waitFor(async () => expect((await bot.durability!.inbox.list())[0]?.state).toBe('done'))
    const [rec] = await bot.durability!.inbox.list()
    const [send] = await bot.durability!.outbox.list()
    expect(send).toMatchObject({ key: `${rec.id}:0`, causationId: rec.id, state: 'sent', chatId: 'u1' })
    expect(send.result?.ref.id).toMatch(/^mock-/)
    expect(provider.outbox[0].options).toBeUndefined()
    expect(bot.durability!.metrics()).toMatchObject({ inboundJournaled: 1, outboxJournaled: 1 })
  })

  it('a redelivery of a processed message never runs handlers again (even without the in-memory deduper)', async () => {
    const { bot, provider } = await makeBot({ durability: {}, dedupe: false })
    const seen: string[] = []
    bot.onMessage(async (ctx) => { seen.push(ctx.body); await ctx.reply('ok') })
    provider.incoming('hola', { from: 'u1', id: 'm1' })
    await vi.waitFor(async () => expect((await bot.durability!.inbox.list())[0]?.state).toBe('done'))
    provider.incoming('hola', { from: 'u1', id: 'm1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['hola'])
    expect(texts(provider)).toEqual(['ok'])
    expect(bot.durability!.metrics().inboundDuplicates).toBe(1)
  })

  it('an explicit idempotencyKey sends once and answers repeats from the outbox', async () => {
    const { bot, provider } = await makeBot({ durability: {} })
    const a = await bot.send('c1', 'hola', { idempotencyKey: 'promo:1' })
    const b = await bot.send('c1', 'hola', { idempotencyKey: 'promo:1' })
    expect(provider.outbox).toHaveLength(1)
    expect(provider.outbox[0].options).toEqual({})
    expect(b.ref).toEqual(a.ref)
    expect(bot.durability!.metrics().outboxDeduped).toBe(1)
  })

  it('retries a retryable failure inline (honouring retryAfterMs) and records the attempts', async () => {
    const provider = new FlakyProvider()
    provider.failures = [new RateLimitedError(15), new Error('socket hang up')]
    const { bot } = await makeBot({ durability: { outbox: { backoff: { baseMs: 1, jitter: 0 } } } }, provider)
    const t0 = Date.now()
    const sent = await bot.send('c1', 'hola', { idempotencyKey: 'k1' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(14)
    expect(provider.calls).toBe(3)
    expect(await bot.durability!.outbox.get('k1')).toMatchObject({ state: 'sent', attempts: 3, result: { ref: sent.ref } })
    expect(bot.durability!.metrics().outboxRetried).toBe(2)
  })

  it('a terminal error dead-letters at once and rejects like before', async () => {
    const provider = new FlakyProvider()
    provider.failures = [new UnsupportedContentError('poll')]
    const { bot } = await makeBot({ durability: {} }, provider)
    const dead = vi.fn()
    bot.on('durability:dead', dead)
    await expect(bot.send('c1', 'x', { idempotencyKey: 'k' })).rejects.toBeInstanceOf(UnsupportedContentError)
    expect(provider.calls).toBe(1)
    expect(await bot.durability!.outbox.get('k')).toMatchObject({ state: 'dead', lastError: { name: 'UnsupportedContentError' } })
    expect(dead).toHaveBeenCalledWith(expect.objectContaining({ kind: 'outbound', id: 'k', chatId: 'c1' }))
    // an operator retry re-queues it and the sweeper delivers it
    await bot.durability!.retrySend('k')
    await vi.waitFor(async () => expect((await bot.durability!.outbox.get('k'))?.state).toBe('sent'))
  })

  it('exhausted retries dead-letter the send', async () => {
    const provider = new FlakyProvider()
    provider.failures = [new Error('a'), new Error('b'), new Error('c')]
    const { bot } = await makeBot({ durability: { outbox: { retries: 2, backoff: () => 1 } } }, provider)
    await expect(bot.send('c1', 'x', { idempotencyKey: 'k' })).rejects.toThrow('c')
    expect(provider.calls).toBe(3)
    expect((await bot.durability!.outbox.get('k'))?.state).toBe('dead')
  })

  it('past inlineMaxMs the send is deferred (SendDeferredError) and the sweeper finishes it', async () => {
    const provider = new FlakyProvider()
    provider.failures = [new Error('down')]
    const { bot } = await makeBot({ durability: { pollMs: 10, outbox: { inlineMaxMs: 0, backoff: () => 5 } } }, provider)
    const after = vi.fn()
    bot.after('send', after)
    const err = await bot.send('c1', 'later', { idempotencyKey: 'k' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SendDeferredError)
    expect((err as SendDeferredError).key).toBe('k')
    expect(after).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect((await bot.durability!.outbox.get('k'))?.state).toBe('sent'))
    expect(texts(provider)).toEqual(['later'])
    expect(after).toHaveBeenCalledTimes(1)
    expect(bot.durability!.metrics().outboxDeferred).toBe(1)
  })

  it('keeps per-chat send order while a send is retried inline', async () => {
    const provider = new FlakyProvider()
    provider.failures = [new Error('blip')]
    const { bot } = await makeBot({ durability: { outbox: { backoff: () => 20 } } }, provider)
    await Promise.all([bot.send('c1', 'first'), bot.send('c1', 'second'), bot.send('c2', 'other')])
    expect(texts(provider).filter((t) => t !== 'other')).toEqual(['first', 'second'])
  })

  it('bot.enqueue journals, runs before-send hooks once and is idempotent by key', async () => {
    const { bot, provider } = await makeBot({ durability: { pollMs: 10 } })
    const before = vi.fn(async (p: { content: OutboundContent }, next: () => Promise<void>) => {
      if (p.content.kind === 'text') p.content = { kind: 'text', text: p.content.text.toUpperCase() }
      await next()
    })
    bot.before('send', before as never)
    expect(await bot.enqueue('c1', 'reminder', { idempotencyKey: 'r:1' })).toEqual({ key: 'r:1', status: 'queued' })
    expect(await bot.enqueue('c1', 'reminder', { idempotencyKey: 'r:1' })).toEqual({ key: 'r:1', status: 'exists' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['REMINDER']))
    expect(before).toHaveBeenCalledTimes(1)
    const stored = await (bot as unknown as { store: { getMessagesByChat(c: string, n: number): Promise<Array<{ status: string }>> } }).store.getMessagesByChat('c1', 10)
    expect(stored.map((m) => m.status)).toContain('sent')
  })

  it('acks a message delivered to a conversation only once the step it fed settles', async () => {
    const { bot, provider } = await makeBot({ durability: {} })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    bot.when('pedido', flow('pedido')
      .ask('¿Nombre?', 'name')
      .do(async () => { await gate })
      .say((_ctx, c) => `Gracias ${String(c.state.name)}`)
      .ask('¿Algo más?', 'more'))
    provider.incoming('pedido', { from: 'u1', id: 'm1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['¿Nombre?']))
    provider.incoming('Ana', { from: 'u1', id: 'm2' })
    await new Promise((r) => setTimeout(r, 30))
    const byBody = async (b: string) => (await bot.durability!.inbox.list()).find((r) => (r.payload as { message: { body: string } }).message.body === b)
    expect((await byBody('pedido'))?.state).toBe('done')
    expect((await byBody('Ana'))?.state).toBe('processing') // its step is still running
    release()
    await vi.waitFor(async () => expect((await byBody('Ana'))?.state).toBe('done'))
    expect(texts(provider)).toEqual(['¿Nombre?', 'Gracias Ana', '¿Algo más?'])
    // the flow's sends were keyed by the message that fed each step
    const keys = (await bot.durability!.outbox.list()).map((r) => r.causationId)
    expect(keys).toEqual([(await byBody('pedido'))!.id, (await byBody('Ana'))!.id, (await byBody('Ana'))!.id])
  })

  it('a handler error still acks the event (its side effects already ran)', async () => {
    const { bot, provider } = await makeBot({ durability: {} })
    bot.on('error', () => {})
    bot.onMessage(async () => { throw new Error('handler bug') })
    provider.incoming('x', { from: 'u1', id: 'm1' })
    await vi.waitFor(async () => expect((await bot.durability!.inbox.list())[0]?.state).toBe('done'))
  })

  it('a pipeline failure before dispatch is retried with backoff, then dead-lettered', async () => {
    const store = new MemoryStore()
    let failSaves = 2
    const save = store.saveMessage.bind(store)
    store.saveMessage = async (m) => { if (failSaves-- > 0) throw new Error('db down'); return save(m) }
    const { bot, provider } = await makeBot({ store, durability: { pollMs: 10, inbox: { backoff: () => 5 } } })
    bot.on('error', () => {})
    const seen: string[] = []
    bot.onMessage(async (ctx) => { seen.push(ctx.body) })
    provider.incoming('hola', { from: 'u1', id: 'm1' })
    await vi.waitFor(() => expect(seen).toEqual(['hola']))
    await vi.waitFor(async () => expect((await bot.durability!.inbox.list())[0]).toMatchObject({ state: 'done', attempts: 3 }))

    failSaves = 100
    const dead = vi.fn()
    bot.on('durability:dead', dead)
    provider.incoming('poison', { from: 'u1', id: 'm2' })
    await vi.waitFor(() => expect(dead).toHaveBeenCalledWith(expect.objectContaining({ kind: 'inbound' })), { timeout: 3000 })
    expect((await bot.durability!.inbox.list({ state: 'dead' }))).toHaveLength(1)
  })

  it('fail-closed: when the journal is down the event is not dispatched; failOpen dispatches it', async () => {
    for (const failOpen of [false, true]) {
      const journal = new MemoryDurability()
      journal.inbox.append = async () => { throw new Error('journal down') }
      const { bot, provider } = await makeBot({ durability: { journal, failOpen } })
      const errors = vi.fn()
      bot.on('error', errors)
      const seen: string[] = []
      bot.onMessage(async (ctx) => { seen.push(ctx.body) })
      provider.incoming('hola', { from: 'u1', id: 'm1' })
      await vi.waitFor(() => expect(errors).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 10))
      expect(seen).toEqual(failOpen ? ['hola'] : [])
    }
  })

  it('stop() during a running step releases its event (replayed on the next start)', async () => {
    const journal = new MemoryDurability()
    const { bot, provider } = await makeBot({ durability: { journal } })
    let started!: () => void
    const running = new Promise<void>((r) => { started = r })
    bot.when('go', flow('go').do(async () => { started(); await new Promise(() => {}) }))
    provider.incoming('go', { from: 'u1', id: 'm1' })
    await running
    await bot.stop()
    expect((await journal.inbox.list())[0]).toMatchObject({ state: 'pending', attempts: 0 })
  })

  it('validates the configuration', () => {
    const provider = new MockProvider()
    expect(() => new Bot({ provider, durability: { outbox: { onAmbiguous: 'maybe' as never } } })).toThrow(/onAmbiguous/)
    expect(() => new Bot({ provider, durability: { inbox: { maxAttempts: 0 } } })).toThrow(/maxAttempts/)
    expect(() => new Bot({ provider, durability: { journal: {} as never } })).toThrow(/journal/)
    expect(() => new Bot({ provider, durability: { pollMs: 'soon' } })).toThrow(/pollMs/)
  })
})
