import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { BotConfig } from '../src/core/types.js'

async function setup(config: Omit<BotConfig, 'provider'> = {}, start = true) {
  const provider = new MockProvider()
  const bot = new Bot({ ...config, provider })
  if (start) await bot.start()
  return { bot, provider }
}

const texts = (provider: MockProvider, chatId?: string) => provider.outbox
  .filter((m) => chatId === undefined || m.chatId === chatId)
  .map((m) => (m.content.kind === 'text' ? m.content.text : `[${m.content.kind}]`))

const waitText = (provider: MockProvider, text: string, chatId?: string) =>
  vi.waitFor(() => expect(texts(provider, chatId)).toContain(text), { timeout: 1000, interval: 5 })

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('bot.trigger', () => {
  it('starts a DSL flow with c.state seeded from data', async () => {
    const { bot, provider } = await setup()
    bot.use(flow('recordatorio')
      .say((_ctx, c) => `Recuerda tu cita ${String(c.state.cita)} con ${String(c.state.doctor)}`)
      .ask('¿Confirmas?', 'ok')
      .say((_ctx, c) => `ok=${String(c.state.ok)} cita=${String(c.state.cita)}`))
    const res = await bot.trigger('recordatorio', { chatId: 'u1', data: { cita: 'mañana 3pm', doctor: 'Dr. García' } })
    expect(res).toEqual({ started: true, name: 'recordatorio', chatId: 'u1', userId: 'u1' })
    await waitText(provider, 'Recuerda tu cita mañana 3pm con Dr. García', 'u1')
    await waitText(provider, '¿Confirmas?', 'u1')
    provider.incoming('sí', { from: 'u1' })
    await waitText(provider, 'ok=sí cita=mañana 3pm', 'u1')
    await bot.stop()
  })

  it('starts a bot.conversation and exposes data on c.state and the synthetic ctx.raw', async () => {
    const { bot, provider } = await setup()
    let raw: unknown
    bot.conversation('encuesta', async (c, ctx) => {
      raw = ctx.raw
      await c.say(`Hola ${String(c.state.nombre)}`)
    })
    await bot.trigger('encuesta', { chatId: 'u1', data: { nombre: 'Ana' } })
    await waitText(provider, 'Hola Ana', 'u1')
    expect(raw).toEqual({ synthetic: 'trigger', name: 'encuesta' })
    await bot.stop()
  })

  it('rejects an unknown name and invalid options', async () => {
    const { bot } = await setup()
    await expect(bot.trigger('nope', { chatId: 'u1' })).rejects.toThrow(/not registered/)
    bot.conversation('x', async () => {})
    await expect(bot.trigger('x', { chatId: '' })).rejects.toBeInstanceOf(TypeError)
    await expect(bot.trigger('x', { chatId: 'u1', data: [] as unknown as Record<string, unknown> })).rejects.toBeInstanceOf(TypeError)
    await bot.stop()
  })

  it('does not start while the bot is stopped', async () => {
    const { bot, provider } = await setup({}, false)
    bot.conversation('x', async (c) => { await c.say('hi') })
    expect(await bot.trigger('x', { chatId: 'u1' })).toMatchObject({ started: false, reason: 'stopped' })
    expect(provider.outbox).toHaveLength(0)
  })

  it('respects the blacklist and the whitelist', async () => {
    const { bot, provider } = await setup()
    bot.conversation('x', async (c) => { await c.say('hi') })
    bot.blacklist.add('bad')
    expect(await bot.trigger('x', { chatId: 'bad' })).toMatchObject({ started: false, reason: 'blocked' })
    bot.whitelist.enable().add('vip')
    expect(await bot.trigger('x', { chatId: 'other' })).toMatchObject({ started: false, reason: 'blocked' })
    expect(await bot.trigger('x', { chatId: 'vip' })).toMatchObject({ started: true })
    await waitText(provider, 'hi', 'vip')
    expect(texts(provider, 'bad')).toEqual([])
    expect(texts(provider, 'other')).toEqual([])
    await bot.stop()
  })

  it('respects human handoff', async () => {
    const { bot, provider } = await setup()
    bot.conversation('x', async (c) => { await c.say('hi') })
    await bot.handoff('u1')
    expect(await bot.trigger('x', { chatId: 'u1' })).toMatchObject({ started: false, reason: 'handoff' })
    await tick()
    expect(texts(provider, 'u1')).toEqual([])
    await bot.resume('u1')
    expect(await bot.trigger('x', { chatId: 'u1' })).toMatchObject({ started: true })
    await waitText(provider, 'hi', 'u1')
    await bot.stop()
  })

  it('skips a subject with a live conversation by default, replaces it on demand', async () => {
    const { bot, provider } = await setup()
    bot.conversation('a', async (c) => { await c.ask('¿a?'); await c.say('a done') })
    bot.conversation('b', async (c) => { await c.say('b start') })
    await bot.trigger('a', { chatId: 'u1' })
    await waitText(provider, '¿a?', 'u1')
    expect(await bot.trigger('b', { chatId: 'u1' })).toMatchObject({ started: false, reason: 'busy' })
    expect(await bot.trigger('b', { chatId: 'u1', ifActive: 'replace' })).toMatchObject({ started: true })
    await waitText(provider, 'b start', 'u1')
    provider.incoming('respuesta', { from: 'u1' })
    await tick()
    expect(texts(provider, 'u1')).not.toContain('a done')
    await bot.stop()
  })

  it('treats a dormant persisted checkpoint as busy', async () => {
    const store = new MemoryStore()
    const persistent = () => flow('reg').persistent().say('bienvenido').ask('¿nombre?', 'name').say('fin')
    const first = await setup({ store })
    first.bot.use(persistent())
    await first.bot.trigger('reg', { chatId: 'u1' })
    await waitText(first.provider, '¿nombre?', 'u1')
    await first.bot.stop()

    const second = await setup({ store })
    second.bot.use(persistent())
    second.bot.conversation('other', async (c) => { await c.say('other') })
    await second.bot.stop()
    await second.bot.start()
    expect(await second.bot.trigger('other', { chatId: 'u1' })).toMatchObject({ started: false, reason: 'busy' })
    expect(await second.bot.trigger('other', { chatId: 'u1', ifActive: 'replace' })).toMatchObject({ started: true })
    await waitText(second.provider, 'other', 'u1')
    // the dormant checkpoint was discarded: the next message does not resume 'reg'
    second.provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(texts(second.provider, 'u1')).not.toContain('¿nombre?')
    await second.bot.stop()
  })

  it('keys group conversations per participant', async () => {
    const { bot, provider } = await setup()
    bot.conversation('q', async (c) => {
      const a = await c.ask('¿qué?')
      await c.say(`dijiste ${a}`)
    })
    await bot.trigger('q', { chatId: 'g1', userId: 'p1', isGroup: true })
    await waitText(provider, '¿qué?', 'g1')
    provider.incoming('otro', { from: 'g1', sender: 'p2', isGroup: true })
    provider.incoming('esto', { from: 'g1', sender: 'p1', isGroup: true })
    await waitText(provider, 'dijiste esto', 'g1')
    expect(texts(provider, 'g1')).not.toContain('dijiste otro')
    await bot.stop()
  })

  it('is ordered with messages already queued for the chat', async () => {
    const { bot, provider } = await setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    bot.when('lento', async (ctx) => { await gate; await ctx.reply('lento listo') })
    bot.conversation('x', async (c) => { await c.say('trigger') })
    provider.incoming('lento', { from: 'u1' })
    await tick(5)
    const pending = bot.trigger('x', { chatId: 'u1' })
    await tick(10)
    expect(texts(provider, 'u1')).toEqual([])
    release()
    await pending
    await waitText(provider, 'trigger', 'u1')
    expect(texts(provider, 'u1')).toEqual(['lento listo', 'trigger'])
    await bot.stop()
  })

  it('awaiting trigger from a command of the same chat does not deadlock its queue', async () => {
    const { bot, provider } = await setup()
    let result: unknown
    bot.conversation('x', async (c) => { await c.say('x started') })
    bot.command('go', async (ctx) => { result = await bot.trigger('x', { chatId: ctx.from }) })
    bot.when('ping', (ctx) => ctx.reply('pong'))
    provider.incoming('/go', { from: 'u1' })
    await waitText(provider, 'x started', 'u1')
    await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 1000, interval: 5 })
    await tick()
    provider.incoming('ping', { from: 'u1' })
    await waitText(provider, 'pong', 'u1')
    expect(result).toMatchObject({ started: true, name: 'x' })
    await bot.stop()
  })

  it('a trigger launched later from a finished handler still waits its turn in the queue', async () => {
    const { bot, provider } = await setup()
    let later: Promise<unknown> | undefined
    bot.conversation('x', async (c) => { await c.say('x started') })
    bot.command('go', (ctx) => { later = new Promise((r) => setTimeout(r, 5)).then(() => bot.trigger('x', { chatId: ctx.from })) })
    provider.incoming('/go', { from: 'u1' })
    await vi.waitFor(() => expect(later).toBeDefined())
    await expect(later).resolves.toMatchObject({ started: true })
    await waitText(provider, 'x started', 'u1')
    await bot.stop()
  })
})

describe('bot.trigger + messaging', () => {
  it('a triggered conversation gets the same messaging seams as an inbound one', async () => {
    const { bot, provider } = await setup()
    let support: string | undefined
    bot.conversation('aviso', async (c, ctx) => {
      // MockProvider has no typing capability: the bot's capability seam says so.
      support = (ctx as unknown as { supports(f: string): string }).supports('typing')
      await c.say('hola')
    })
    await bot.trigger('aviso', { chatId: 'u1' })
    await waitText(provider, 'hola', 'u1')
    expect(support).toBe('unsupported')
    await bot.stop()
  })
})
