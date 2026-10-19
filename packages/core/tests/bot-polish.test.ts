/**
 * Characterization tests for the core-polish refactor of `core/bot/*` (no behaviour
 * change): the diagnostics names other code reads off the bot, `triggerFlow` delegation,
 * access-list / handoff drop accounting and logs, lifecycle rollback logs, send-hook
 * payload shapes and the string → text normalization of send / enqueue / broadcast.
 * Written against the pre-refactor code; they must stay green after it.
 */
import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'

import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { HookHandler } from '../src/core/types.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

type LogLine = { level: number; msg: string; [k: string]: unknown }
function captureLogger() {
  const lines: LogLine[] = []
  const logger = pino({ level: 'debug' }, { write: (s: string) => { lines.push(JSON.parse(s) as LogLine) } })
  return { logger, lines }
}

/** The private names diagnostics (soak script, soak-regressions) and plugins read off a bot. */
const DIAGNOSTIC_NAMES = [
  'config', 'store', 'provider', 'namespace', 'users', 'runtime', 'dispatcher', 'inboundDedupe', 'tools',
  'inflightSends', 'flowRoutes', 'welcome', 'inflightEvents', 'handoffs', 'chatWrites', 'externalSends',
  'i18n', 'flowRegistry', 'scheduler', 'idle', 'counters', 'state',
] as const

describe('core polish: diagnostics names', () => {
  it('reads the same kernel objects from the bot and from a plugin-scoped bot', () => {
    const provider = new MockProvider()
    const store = new MemoryStore()
    const bot = new Bot({ provider, store })
    let scoped: Bot | undefined
    bot.plug({ name: 'spy', version: '1.0.0', install({ bot: b }) { scoped = b } })
    const real = bot as unknown as Record<string, unknown>
    const viaPlugin = scoped as unknown as Record<string, unknown>
    for (const name of DIAGNOSTIC_NAMES) {
      expect(real[name], name).toBeDefined()
      expect(viaPlugin[name], name).toBe(real[name])
    }
    expect(real.provider).toBe(provider)
    expect(real.store).toBe(bot.getStore())
    expect((real.config as { commandPrefix?: string }).commandPrefix).toBe('/')
    expect(real.namespace).toBe(bot.getNamespace())
    expect(typeof (real.scheduler as { delay?: unknown }).delay).toBe('function')
  })

  it('uses the durable scheduler built by BotConfig.scheduler', async () => {
    const bot = new Bot({ provider: new MockProvider(), scheduler: {} })
    const scheduler = (bot as unknown as { scheduler: { every: unknown } }).scheduler
    expect(typeof scheduler.every).toBe('function')
    // onIdle schedules through the same scheduler object (late-bound).
    const spy = vi.spyOn(scheduler as unknown as { delay: (...a: unknown[]) => unknown }, 'delay')
    bot.onIdle('1m', () => {})
    const provider = bot.getProvider() as MockProvider
    await bot.start()
    provider.incoming('hola')
    await tick()
    expect(spy).toHaveBeenCalled()
    await bot.stop()
  })
})

describe('core polish: triggerFlow', () => {
  it('goes through a spied bot.trigger with ifActive replace', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    bot.registerFlow(flow('promo').say('hola'))
    await bot.start()
    const spy = vi.spyOn(bot, 'trigger')
    expect(await bot.triggerFlow('promo', { chatId: 'u1', userId: 'u1' }, { state: { a: 1 }, body: 'b' })).toBe(true)
    expect(spy).toHaveBeenCalledWith('promo', {
      chatId: 'u1', userId: 'u1', isGroup: false, data: { a: 1 }, body: 'b', ifActive: 'replace',
    })
    await bot.stop()
  })

  it('resolves false for unknown flows, blocked subjects and handed-off chats; rejects when not started', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    bot.registerFlow(flow('promo').say('hola'))
    await expect(bot.triggerFlow('promo', { chatId: 'u1' })).rejects.toThrow('triggerFlow() needs a started bot')
    await bot.start()
    expect(await bot.triggerFlow('nope', { chatId: 'u1' })).toBe(false)
    bot.blacklist.add('bad')
    expect(await bot.triggerFlow('promo', { chatId: 'bad' })).toBe(false)
    await bot.handoff('h1')
    expect(await bot.triggerFlow('promo', { chatId: 'h1' })).toBe(false)
    vi.spyOn(bot, 'trigger').mockResolvedValue({ name: 'promo', chatId: 'u1', userId: 'u1', started: false, reason: 'stopped' })
    await expect(bot.triggerFlow('promo', { chatId: 'u1' })).rejects.toThrow('triggerFlow() needs a started bot')
    await bot.stop()
  })
})

describe('core polish: access-list and handoff drops', () => {
  it('counts each blocked message, interaction, call and trigger once and logs the inbound/call drops', async () => {
    const { logger, lines } = captureLogger()
    const provider = new MockProvider()
    const bot = new Bot({ provider, logger })
    bot.conversation('c', async (c) => { await c.say('hi') })
    const seen: string[] = []
    bot.onMessage((ctx) => { seen.push(ctx.body) })
    await bot.start()
    bot.blacklist.add('bad')

    provider.incoming('m1', { from: 'bad', id: 'dup-1' }); await tick()
    expect(bot.metrics().dropped.blocked).toBe(1)
    provider.interaction('i1', { from: 'bad' }); await tick()
    expect(bot.metrics().dropped.blocked).toBe(2)
    provider.call({ from: 'bad' }); await tick()
    expect(bot.metrics().dropped.blocked).toBe(3)
    expect((await bot.trigger('c', { chatId: 'bad' })).reason).toBe('blocked')
    expect(bot.metrics().dropped.blocked).toBe(4)

    const drops = lines.filter((l) => l.msg === 'inbound dropped by access list')
    expect(drops.map(({ gate, chatId, senderId }) => ({ gate, chatId, senderId })))
      .toEqual([{ gate: 'blacklisted', chatId: 'bad', senderId: 'bad' }, { gate: 'blacklisted', chatId: 'bad', senderId: 'bad' }])
    const callDrops = lines.filter((l) => l.msg === 'call dropped by access list')
    expect(callDrops.map(({ gate, chatId, senderId }) => ({ gate, chatId, senderId })))
      .toEqual([{ gate: 'blacklisted', chatId: 'bad', senderId: 'bad' }])
    expect(bot.metrics().dropped.duplicate).toBe(0)

    // A blocked delivery is never recorded as seen: once un-blocked the same id is processed.
    bot.blacklist.remove('bad')
    provider.incoming('m1', { from: 'bad', id: 'dup-1' }); await tick()
    expect(seen).toEqual(['m1'])
    await bot.stop()
  })

  it('counts handoff drops of the dispatcher gate, calls and triggers once each', async () => {
    const { logger, lines } = captureLogger()
    const provider = new MockProvider()
    const bot = new Bot({ provider, logger })
    bot.conversation('c', async (c) => { await c.say('hi') })
    await bot.start()
    await bot.handoff('h1')

    provider.incoming('x', { from: 'h1' }); await tick()
    expect(bot.metrics().dropped.handoff).toBe(1)
    provider.call({ from: 'h1' }); await tick()
    expect(bot.metrics().dropped.handoff).toBe(2)
    expect((await bot.trigger('c', { chatId: 'h1' })).reason).toBe('handoff')
    expect(bot.metrics().dropped.handoff).toBe(3)
    const callDrops = lines.filter((l) => l.msg === 'call dropped: chat handed off')
    expect(callDrops.map(({ gate, chatId, senderId }) => ({ gate, chatId, senderId })))
      .toEqual([{ gate: 'handoff', chatId: 'h1', senderId: 'h1' }])
    await bot.stop()
  })
})

describe('core polish: lifecycle rollback logs', () => {
  it('logs the exact storage and transport rollback failures', async () => {
    const { logger, lines } = captureLogger()
    const store = new MemoryStore()
    vi.spyOn(store, 'stop').mockRejectedValue(new Error('store-stop'))
    const provider = new MockProvider()
    vi.spyOn(provider, 'start').mockRejectedValue(new Error('boom'))
    vi.spyOn(provider, 'stop').mockRejectedValue(new Error('provider-stop'))
    const bot = new Bot({ provider, store, logger })
    await expect(bot.start()).rejects.toThrow('boom')
    const errors = lines.filter((l) => l.level === 50).map((l) => l.msg)
    expect(errors).toEqual(['provider start rollback failed', 'store start rollback failed'])
  })
})

describe('core polish: send hook payloads', () => {
  it('keeps the exact payload keys of send and edit, and the skipped results', async () => {
    const provider = new MockProvider({ supports: { edit: true } })
    const bot = new Bot({ provider })
    const keys: string[][] = []
    let abort = false
    const hook: HookHandler = (payload, next) => {
      keys.push(Object.keys(payload as object).sort())
      if (abort) (payload as { abort(): void }).abort()
      return next()
    }
    bot.before('send', hook)
    bot.when('edit', async (ctx) => {
      const sent = await ctx.reply('one')
      await ctx.edit(sent, 'two')
    })
    await bot.start()
    await bot.send('u1', 'hola')
    provider.incoming('edit'); await tick()
    expect(keys).toEqual([
      ['abort', 'chatId', 'content', 'options'],
      ['abort', 'chatId', 'content', 'options'],
      ['abort', 'chatId', 'content', 'edit', 'options'],
    ])
    abort = true
    expect(await bot.send('u1', 'skip')).toEqual({ ref: { id: 'skipped', chatId: 'u1' }, id: 'skipped', chatId: 'u1', raw: undefined, skipped: true })
    await bot.stop()
  })
})

describe('core polish: string content normalization', () => {
  it('sends, enqueues and broadcasts a string as text', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider, durability: {} })
    await bot.start()
    await bot.send('a', 'uno')
    await bot.broadcast(['b'], 'dos')
    await bot.enqueue('c', 'tres', { idempotencyKey: 'k1' })
    for (let i = 0; i < 50 && provider.outbox.length < 3; i++) await tick()
    expect(provider.outbox.map((m) => [m.chatId, m.content])).toEqual([
      ['a', { kind: 'text', text: 'uno' }],
      ['b', { kind: 'text', text: 'dos' }],
      ['c', { kind: 'text', text: 'tres' }],
    ])
    await bot.stop()
  })
})
