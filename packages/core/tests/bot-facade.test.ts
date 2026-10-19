/**
 * Characterization tests for the Bot facade: the late-bound seams that the split of
 * Bot.ts into `core/bot/*` modules must keep (plugin-scoped bots built with
 * `Object.create`, subclass overrides, spies installed after construction).
 */
import { describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { ChatId } from '../src/core/types.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('Bot facade: plugin-scoped registrations', () => {
  it('routes a plugin registers through use(flow), when(t, flow), conversation() and registerFlow() go away on unplug', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    const unplug = bot.plug({
      name: 'p',
      version: '1.0.0',
      install({ bot: b }) {
        b.use(flow('used').say('from-use'))
        b.when('whenflow', flow('whenf').say('from-when'))
        b.conversation('conv', async (c) => { await c.say('from-conv') })
        b.registerFlow(flow('reg').say('from-reg'))
      },
    })
    for (const t of ['used', 'whenflow', 'conv', 'reg']) { provider.incoming(t, { from: `u-${t}` }); await tick() }
    expect(provider.outbox.map((m) => (m.content as { text: string }).text).sort())
      .toEqual(['from-conv', 'from-reg', 'from-use', 'from-when'])

    unplug()
    provider.outbox = []
    expect(bot.hasFlow('reg')).toBe(false)
    for (const t of ['used', 'whenflow', 'conv', 'reg']) { provider.incoming(t, { from: `v-${t}` }); await tick() }
    expect(provider.outbox).toEqual([])
    expect(bot.flowInventory().routes).toEqual([])
    await bot.stop()
  })

  it('a nested plugin plugged through ctx.bot.use(plugin) is unplugged with its parent', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    const unplug = bot.plug({
      name: 'parent',
      version: '1.0.0',
      install({ bot: b }) {
        b.use({ name: 'child', version: '1.0.0', requires: ['parent'], install({ bot: c }) { c.command('ping', (ctx) => ctx.reply('pong')) } })
      },
    })
    provider.incoming('/ping'); await tick()
    expect(provider.outbox).toHaveLength(1)
    unplug()
    provider.incoming('/ping'); await tick()
    expect(provider.outbox).toHaveLength(1)
    await bot.stop()
  })
})

describe('Bot facade: late-bound lookups', () => {
  it('a subclass isHandedOff() override is honoured by paced replies', async () => {
    const handedOff = new Set<ChatId>()
    class HandoffBot extends Bot {
      override isHandedOff(chatId: ChatId): boolean { return handedOff.has(chatId) || super.isHandedOff(chatId) }
    }
    const provider = new MockProvider()
    const bot = new HandoffBot({ provider })
    await bot.start()
    bot.when('hola', async (ctx) => {
      const p = ctx.reply('late', { delay: 40 })
      setTimeout(() => handedOff.add(ctx.from), 10)
      const r = await p
      expect(r.skipped).toBe(true)
    })
    const errors: unknown[] = []
    bot.on('error', (e) => errors.push(e))
    provider.incoming('hola', { from: 'u1' })
    await new Promise((r) => setTimeout(r, 80))
    expect(provider.outbox).toEqual([])
    expect(errors).toEqual([])
    await bot.stop()
  })

  it('a spy on emit installed after construction sees connection, message, handoff and conversation events', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const spy = vi.spyOn(bot, 'emit')
    bot.conversation('c', async (c) => { await c.say('hi') })
    await bot.start()
    provider.incoming('c', { from: 'u1' }); await tick()
    await bot.handoff('u1')
    const names = spy.mock.calls.map((c) => c[0])
    for (const e of ['connection', 'ready', 'started', 'message', 'conversation:started', 'conversation:ended', 'handoff']) {
      expect(names).toContain(e)
    }
    await bot.stop()
  })

  it('bot.ready resolves before the "ready" event handlers run', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    let resolved = false
    void bot.ready.then(() => { resolved = true })
    const seen: boolean[] = []
    bot.on('ready', () => { void Promise.resolve().then(() => seen.push(resolved)) })
    await bot.start()
    await tick()
    expect(seen).toEqual([true])
    await bot.stop()
  })
})

describe('Bot facade: lifecycle and pipelines', () => {
  it('start rollback stops provider and store, leaves the state closed and can start again', async () => {
    const provider = new MockProvider()
    const store = new MemoryStore()
    const realStart = provider.start.bind(provider)
    provider.start = vi.fn().mockRejectedValueOnce(new Error('down')).mockImplementation(realStart)
    provider.stop = vi.fn(provider.stop.bind(provider))
    store.stop = vi.fn(store.stop.bind(store))
    const bot = new Bot({ provider, store })
    await expect(bot.start()).rejects.toThrow('down')
    expect(bot.getConnectionState()).toBe('closed')
    expect(provider.stop).toHaveBeenCalledOnce()
    expect(store.stop).toHaveBeenCalledOnce()
    await bot.start()
    expect(bot.getConnectionState()).toBe('ready')
    await bot.stop()
    expect(bot.getConnectionState()).toBe('closed')
  })

  it('stop({ drain: true }) waits for a paced reply in flight', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    bot.when('hola', (ctx) => { void ctx.reply('drained', { delay: 40 }) })
    provider.incoming('hola'); await tick()
    await bot.stop({ drain: true })
    expect(provider.outbox.map((m) => (m.content as { text: string }).text)).toEqual(['drained'])
  })

  it('stop({ drain: true }) waits for a broadcast in flight', async () => {
    const provider = new MockProvider()
    const realSend = provider.send.bind(provider)
    provider.send = async (...a) => { await new Promise((r) => setTimeout(r, 20)); return realSend(...a) }
    const bot = new Bot({ provider })
    await bot.start()
    const res = bot.broadcast(['a', 'b', 'c'], 'x', { batchSize: 1, concurrency: 1 })
    await tick()
    await bot.stop({ drain: true })
    const r = await res
    expect(r.sent).toBeGreaterThanOrEqual(1)
    expect(r.sent + r.pending.length).toBe(3)
  })

  it('a before("send") abort returns skipped and calls no provider', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    bot.before('send', async (p: { abort(): void }) => { p.abort() })
    const r = await bot.send('u1', 'hi')
    expect(r.skipped).toBe(true)
    expect(provider.outbox).toEqual([])
    await bot.stop()
  })

  it('dedupe drops a redelivery; a delivery blocked by the access lists is not marked as seen', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    const got: string[] = []
    bot.onMessage((ctx) => { got.push(ctx.body) })
    provider.incoming('one', { from: 'u1', id: 'm1' }); await tick()
    provider.incoming('one', { from: 'u1', id: 'm1' }); await tick()
    expect(got).toEqual(['one'])
    bot.blacklist.add('u2')
    provider.incoming('two', { from: 'u2', id: 'm2' }); await tick()
    bot.blacklist.remove('u2')
    provider.incoming('two', { from: 'u2', id: 'm2' }); await tick()
    expect(got).toEqual(['one', 'two'])
    expect(bot.metrics().dropped).toMatchObject({ duplicate: 1, blocked: 1 })
    await bot.stop()
  })
})
