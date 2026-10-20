/**
 * Echo filter (`BotConfig.echoFilter`): an inbound message carrying the ref of one of the
 * bot's own successful sends is dropped before the access lists, dedupe and the journal
 * (counted in `metrics().dropped.echo`); without the option every path is as before.
 */
import { describe, expect, it, vi } from 'vitest'
import { Bot, ConfigValidationError, MemoryDurability, MemoryStore, SentRefRing, createEchoFilter, type BotConfig } from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

async function started(extra: Partial<BotConfig> = {}) {
  const provider = new MockProvider()
  const store = new MemoryStore()
  const bot = new Bot({ provider, store, logger: silent(), ...extra })
  const seen: string[] = []
  bot.onMessage((ctx) => { seen.push(ctx.body) })
  await bot.start()
  return { bot, provider, store, seen }
}

describe('SentRefRing', () => {
  it('forgets a ref once it is checked, evicts the least recent and honours the TTL', () => {
    let now = 1_000
    const ring = new SentRefRing({ size: 2, ttl: 500, now: () => now })
    ring.remember({ id: 'a', chatId: 'c' })
    ring.remember({ id: 'b', chatId: 'c' })
    ring.remember({ id: 'c', chatId: 'c' })
    expect(ring.remembered).toBe(2)
    expect(ring.has({ id: 'a', chatId: 'c' })).toBe(false) // evicted
    expect(ring.has({ id: 'b', chatId: 'c' })).toBe(true)
    expect(ring.has({ id: 'b', chatId: 'c' })).toBe(false) // check-and-forget
    now += 600
    expect(ring.has({ id: 'c', chatId: 'c' })).toBe(false) // expired
    expect(ring.remembered).toBe(0)
  })

  it('keys by chat id + message id (Telegram-style ids are only unique per chat) and ignores empty refs', () => {
    const ring = new SentRefRing()
    ring.remember({ id: '1', chatId: 'c1' })
    ring.remember({ id: '', chatId: 'c1' })
    ring.remember({ id: '2', chatId: '' })
    expect(ring.remembered).toBe(1)
    expect(ring.has({ id: '1', chatId: 'c2' })).toBe(false)
    expect(ring.has({ id: '', chatId: 'c1' })).toBe(false)
    expect(ring.has({ id: '1', chatId: 'c1' })).toBe(true)
  })

  it('validates its options like the deduper', () => {
    expect(() => new SentRefRing({ size: 0 })).toThrow(ConfigValidationError)
    expect(() => new SentRefRing({ ttl: 'soon' })).toThrow(ConfigValidationError)
    expect(createEchoFilter(undefined)).toBeNull()
    expect(createEchoFilter(true)?.size).toBe(1000)
    expect(createEchoFilter({ size: 5, ttl: '1m' })?.ttlMs).toBe(60_000)
    expect(() => new Bot({ provider: new MockProvider(), echoFilter: { size: -1 } })).toThrow(ConfigValidationError)
    expect(() => new Bot({ provider: new MockProvider(), echoFilter: 'yes' as unknown as true })).toThrow(ConfigValidationError)
  })
})

describe('BotConfig.echoFilter', () => {
  it('drops an inbound that carries the ref of a bot send: not routed, not persisted as inbound, not counted, not deduped', async () => {
    const { bot, provider, store, seen } = await started({ echoFilter: true })
    const sent = await bot.send('c1', 'hello there')
    provider.incoming('hello there', { from: 'c1', id: sent.ref.id })
    await tick()
    expect(seen).toEqual([])
    const m = bot.metrics()
    expect(m.dropped.echo).toBe(1)
    expect(m.messages.in).toBe(0)
    expect((await bot.getStore().getMessage(sent.ref))?.direction).toBe('outbound')
    expect((await store.listChats()).length).toBe(1) // the send persisted its chat; the echo added nothing
    expect(bot.metrics().dropped).toEqual({ duplicate: 0, blocked: 0, handoff: 0, echo: 1 })
    // The ring forgets a ref once it matched, and the deduper never recorded the echo: a
    // later inbound reusing that id (a transport quirk) is processed as new input.
    provider.incoming('a real message', { from: 'c1', id: sent.ref.id })
    await tick()
    expect(seen).toEqual(['a real message'])
    expect(bot.metrics().dropped.echo).toBe(1)
    await bot.stop()
  })

  it('without the option an inbound reusing a sent ref is processed exactly as before', async () => {
    const { bot, provider, seen } = await started()
    const sent = await bot.send('c1', 'hello there')
    provider.incoming('hello there', { from: 'c1', id: sent.ref.id })
    await tick()
    expect(seen).toEqual(['hello there'])
    expect(bot.metrics().dropped).toEqual({ duplicate: 0, blocked: 0, handoff: 0 }) // no `echo` key without the filter
    await bot.stop()
  })

  it('a failed send is not remembered, and the ring is per chat', async () => {
    const { bot, provider, seen } = await started({ echoFilter: true })
    const sent = await bot.send('c1', 'to c1')
    provider.incoming('other chat, same id', { from: 'c2', id: sent.ref.id })
    await tick()
    expect(seen).toEqual(['other chat, same id'])
    provider.send = vi.fn(async () => { throw new Error('boom') })
    await expect(bot.send('c1', 'fails')).rejects.toThrow('boom')
    expect(bot.metrics().dropped.echo).toBe(0)
    await bot.stop()
  })

  it('with durability the echo is never journaled', async () => {
    const journal = new MemoryDurability()
    const { bot, provider, seen } = await started({ echoFilter: true, durability: { journal } })
    const sent = await bot.send('c1', 'durable hello')
    provider.incoming('durable hello', { from: 'c1', id: sent.ref.id })
    provider.incoming('real', { from: 'c1' })
    await vi.waitFor(() => expect(seen).toEqual(['real']))
    const records = await bot.durability!.inbox.list()
    expect(records.map((r) => JSON.stringify(r.payload).includes('"durable hello"'))).toEqual([false])
    expect(bot.metrics().dropped.echo).toBe(1)
    await bot.stop()
  })

  it('replies from a handler are remembered too (every successful send goes through the ledger)', async () => {
    const provider = new MockProvider()
    const refs: string[] = []
    const send = provider.send.bind(provider)
    provider.send = async (chatId, content, options) => {
      const result = await send(chatId, content, options)
      refs.push(result.ref.id)
      return result
    }
    const bot = new Bot({ provider, logger: silent(), echoFilter: true })
    const bodies: string[] = []
    bot.onMessage(async (ctx) => { bodies.push(ctx.body); if (ctx.body === 'hi') await ctx.reply('hey') })
    await bot.start()
    provider.incoming('hi', { from: 'c1' })
    await vi.waitFor(() => expect(refs).toHaveLength(1))
    await tick()
    provider.incoming('hey', { from: 'c1', id: refs[0] })
    await tick()
    expect(bodies).toEqual(['hi'])
    expect(bot.metrics().dropped.echo).toBe(1)
    await bot.stop()
  })
})
