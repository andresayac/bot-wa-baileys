/**
 * Cross-feature checks for the wave-2 features merged together (onIdle × handoff, …).
 * Each feature has its own suite; this file covers how they interact in one Bot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { MemoryStore } from '../src/store/MemoryStore.js'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('onIdle × human handoff (real bot.handoff / bot.resume)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('bot.handoff() cancels the chat idle timer and bot.resume() lets it re-arm', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    const fired: string[] = []
    bot.onIdle(1000, (_ctx, e) => { fired.push(e.chatId) })
    provider.incoming('hola', { from: 'chat-a' }); await settle()
    await bot.handoff('chat-a'); await settle()
    provider.incoming('con el agente', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).toEqual([])
    await bot.resume('chat-a'); await settle()
    provider.incoming('de vuelta', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fired).toEqual(['chat-a'])
    await bot.stop()
  })

  it('a handoff restored from the store at start() (no event) still suspends onIdle', async () => {
    const store = new MemoryStore()
    const first = new Bot({ provider: new MockProvider(), store })
    await first.start()
    await first.handoff('chat-a'); await settle()
    await first.stop()

    const provider = new MockProvider()
    const bot = new Bot({ provider, store })
    await bot.start()
    expect(bot.isHandedOff('chat-a')).toBe(true)
    const fired = vi.fn()
    bot.onIdle(1000, fired)
    provider.incoming('sigo con el agente', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
    await bot.stop()
  })
})

describe('describe/lint × WELCOME and type triggers', () => {
  it('describes special triggers by name instead of "[object Object]"', async () => {
    const { describeTrigger } = await import('../src/flows/inventory.js')
    const { WELCOME, IMAGE, MEDIA, CALL } = await import('../src/core/triggers.js')
    expect(describeTrigger(WELCOME)).toMatchObject({ label: 'WELCOME', predicate: true, special: { kind: 'welcome' } })
    expect(describeTrigger({ ...IMAGE, scope: 'dm' })).toMatchObject({ label: 'type: image (dm only)', scope: 'dm', special: { kind: 'type', types: ['image'] } })
    expect(describeTrigger(MEDIA).label).toMatch(/^type: image \| /)
    expect(describeTrigger(CALL).label).toBe('type: call')
  })

  it('lint does not report special triggers as empty or duplicate text triggers', async () => {
    const { lintFlows } = await import('../src/flows/lint.js')
    const { flow } = await import('../src/flows/FlowBuilder.js')
    const { WELCOME, IMAGE, MEDIA, CALL } = await import('../src/core/triggers.js')
    const bot = new Bot({ provider: new MockProvider() })
    bot.use([
      flow(WELCOME).id('bienvenida').say('¡Hola!'),
      flow(IMAGE).id('foto').say('linda foto'),
      flow(MEDIA).id('media').say('recibido'),
      flow(CALL).id('llamada').say('no atiendo llamadas'),
    ])
    const diagnostics = lintFlows(bot, { rules: { 'missing-timeout': false } })
    expect(diagnostics).toEqual([])
    const mermaid = bot.describe()
    expect(mermaid).not.toContain('[object Object]')
    expect(mermaid).toContain('WELCOME')
  })
})

describe('CALL trigger × access lists and handoff', () => {
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

  it('a blacklisted caller and a handed-off chat are fully blocked: no CALL trigger and no call event', async () => {
    const { createTestBot } = await import('../src/testing/createTestBot.js')
    const { CALL } = await import('../src/core/triggers.js')
    const { bot, provider } = await createTestBot()
    const handled: string[] = []
    const raw: string[] = []
    bot.when(CALL, (ctx) => { handled.push(ctx.from) })
    bot.on('call', (e) => { raw.push(e.from) })
    bot.blacklist.add('spammer')
    await bot.handoff('with-agent')
    provider.call({ id: 'c1', from: 'spammer' })
    provider.call({ id: 'c2', from: 'with-agent' })
    provider.call({ id: 'c3', from: 'friend' })
    await tick()
    expect(handled).toEqual(['friend'])
    expect(raw).toEqual(['friend'])
    await bot.stop()
  })
})

describe('ctx.user on every context the bot builds', () => {
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

  it('a CALL trigger context carries the caller profile (same data as their messages)', async () => {
    const { createTestBot } = await import('../src/testing/createTestBot.js')
    const { CALL } = await import('../src/core/triggers.js')
    const { bot, provider } = await createTestBot()
    await bot.user('caller-1').set('name', 'Ana')
    let seen: unknown
    bot.when(CALL, async (ctx) => { seen = await ctx.user.get('name') })
    provider.call({ id: 'c1', from: 'caller-1' })
    await tick()
    expect(seen).toBe('Ana')
    await bot.stop()
  })
})
