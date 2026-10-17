import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { RecipientUnreachableError } from '../src/core/provider.js'
import type { BotConfig } from '../src/core/types.js'
import { MetricsCollector, formatUptime, toPrometheus, type ConversationEndedEvent, type ConversationStartedEvent } from '../src/index.js'

async function setup(config: Omit<BotConfig, 'provider'> = {}) {
  const provider = new MockProvider()
  const bot = new Bot({ ...config, provider })
  await bot.start()
  return { bot, provider }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('conversation lifecycle events', () => {
  it("emits 'conversation:started' and 'conversation:ended' with outcome and duration", async () => {
    const { bot, provider } = await setup()
    const started: ConversationStartedEvent[] = []
    const ended: ConversationEndedEvent[] = []
    bot.on('conversation:started', (e) => started.push(e))
    bot.on('conversation:ended', (e) => ended.push(e))
    bot.use(flow('registro').ask('¿nombre?', 'name').say('fin'))
    provider.incoming('registro', { from: 'u1' })
    await tick()
    expect(started).toEqual([{ name: 'registro', key: 'u1', chatId: 'u1', userId: 'u1' }])
    provider.incoming('Ana', { from: 'u1' })
    await vi.waitFor(() => expect(ended).toHaveLength(1))
    expect(ended[0]).toMatchObject({ name: 'registro', chatId: 'u1', userId: 'u1', outcome: 'completed', completed: true })
    expect(ended[0]!.durationMs).toBeGreaterThanOrEqual(0)
    await bot.stop()
  })

  it('reports timedOut, cancelled, error, retriesExceeded and goto', async () => {
    const { bot, provider } = await setup()
    const ended: ConversationEndedEvent[] = []
    bot.on('conversation:ended', (e) => ended.push(e))
    bot.on('error', () => {})
    bot.conversation('timeout', async (c) => { await c.ask('¿?', { timeout: 10 }) })
    bot.conversation('boom', async () => { throw new Error('boom') })
    bot.conversation('retries', async (c) => {
      await c.ask('¿número?')
      for (;;) await c.retry('otra vez')
    })
    bot.conversation('jump', async (c) => { c.goto('boom') })
    bot.conversation('wait', async (c) => { await c.ask('esperando') })

    provider.incoming('timeout', { from: 't' })
    provider.incoming('boom', { from: 'b' })
    provider.incoming('jump', { from: 'j' })
    provider.incoming('wait', { from: 'w' })
    provider.incoming('retries', { from: 'r' })
    await tick(40)
    for (let i = 0; i < 5; i++) { provider.incoming(`x${i}`, { from: 'r' }); await tick(5) }
    bot.abortConversation('w')
    await vi.waitFor(() => expect(ended.map((e) => e.name).sort()).toEqual(['boom', 'boom', 'jump', 'retries', 'timeout', 'wait']))
    const by = (chat: string, name: string) => ended.find((e) => e.chatId === chat && e.name === name)!
    expect(by('t', 'timeout').outcome).toBe('timedOut')
    expect(by('b', 'boom').outcome).toBe('error')
    expect(by('j', 'jump')).toMatchObject({ outcome: 'completed', goto: 'boom' })
    expect(by('j', 'boom').outcome).toBe('error')
    expect(by('w', 'wait')).toMatchObject({ outcome: 'cancelled', completed: false })
    expect(by('r', 'retries').outcome).toBe('retriesExceeded')
    await bot.stop()
  })

  it('a throwing listener never breaks the conversation', async () => {
    const { bot, provider } = await setup()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.on('conversation:started', () => { throw new Error('listener') })
    bot.conversation('x', async (c) => { await c.say('still runs') })
    provider.incoming('x', { from: 'u1' })
    await vi.waitFor(() => expect(provider.outbox.map((m) => m.content.kind === 'text' && m.content.text)).toContain('still runs'))
    expect(errors).toHaveLength(1)
    await bot.stop()
  })
})

describe('bot.metrics()', () => {
  it('counts conversations, per-flow stats, messages, drops, triggers and errors', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    bot.on('error', () => {})
    bot.use(flow('registro').ask('¿nombre?', 'name').say('fin'))
    bot.conversation('soporte', async (c) => { await c.say('ok') })
    bot.command('fail', async (ctx) => { await ctx.reply('x') })
    await bot.start()

    provider.incoming('registro', { from: 'u1' })
    await tick()
    let m = bot.metrics()
    expect(m.conversations.active).toBe(1)
    expect(m.conversations.started).toBe(1)
    provider.incoming('Ana', { from: 'u1' })
    provider.incoming('soporte', { from: 'u2' })
    await bot.trigger('soporte', { chatId: 'u3' })
    // duplicate (same id) is dropped by dedupe
    provider.incoming('hola', { from: 'u4', id: 'dup' })
    provider.incoming('hola', { from: 'u4', id: 'dup' })
    // blocked
    bot.blacklist.add('bad')
    provider.incoming('hola', { from: 'bad' })
    // handoff
    await bot.handoff('h1')
    provider.incoming('hola', { from: 'h1' })
    // outbound failure → error
    const send = provider.send.bind(provider)
    provider.send = (async (chatId, content, options) => {
      if (chatId === 'f1') throw new RecipientUnreachableError(chatId)
      return send(chatId, content, options)
    }) as typeof provider.send
    provider.incoming('/fail', { from: 'f1' })
    await tick(40)

    m = bot.metrics()
    expect(m.conversations).toMatchObject({ started: 3, completed: 3, cancelled: 0, timedOut: 0, errored: 0, active: 0 })
    expect(m.flows.registro).toMatchObject({ started: 1, completed: 1 })
    expect(m.flows.soporte).toMatchObject({ started: 2, completed: 2 })
    expect(m.messages.in).toBe(6) // registro, Ana, soporte, hola(u4), hola(h1), /fail
    expect(m.messages.out).toBe(4) // ¿nombre?, fin, ok (u2), ok (u3)
    expect(m.messages.outFailed).toBe(1)
    expect(m.dropped).toEqual({ duplicate: 1, blocked: 1, handoff: 1 })
    expect(m.triggered).toBe(1)
    expect(m.errors).toBeGreaterThanOrEqual(1)
    expect(m.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(typeof m.uptime).toBe('string')

    bot.resetMetrics()
    expect(bot.metrics().conversations.started).toBe(0)
    expect(bot.metrics().flows).toEqual({})
    await bot.stop()
    expect(bot.metrics().uptimeMs).toBe(0)
  })
})

describe('MetricsCollector', () => {
  it('computes average durations and uptime from an injected clock', () => {
    let now = 1_000
    const c = new MetricsCollector(() => now)
    c.markStarted()
    c.conversationStarted('a')
    c.conversationStarted('a')
    c.conversationEnded('a', 'completed', 100)
    c.conversationEnded('a', 'timedOut', 300)
    now += 93_784_000
    const s = c.snapshot(0)
    expect(s.conversations).toMatchObject({ started: 2, completed: 1, timedOut: 1, avgDurationMs: 200 })
    expect(s.flows.a!.avgDurationMs).toBe(200)
    expect(s.uptimeMs).toBe(93_784_000)
    expect(s.uptime).toBe('1d 2h')
  })

  it('formats uptime', () => {
    expect(formatUptime(0)).toBe('0s')
    expect(formatUptime(5_000)).toBe('5s')
    expect(formatUptime(312_000)).toBe('5m 12s')
    expect(formatUptime(3 * 86_400_000 + 4 * 3_600_000 + 59_000)).toBe('3d 4h')
  })
})

describe('toPrometheus', () => {
  const snapshot = () => {
    const c = new MetricsCollector(() => 5_000)
    c.markStarted()
    c.conversationStarted('re"g\\x\n')
    c.conversationEnded('re"g\\x\n', 'completed', 1500)
    c.inbound()
    c.outbound(true)
    c.outbound(false)
    c.duplicateDropped()
    c.error()
    return c.snapshot(2)
  }

  it('renders HELP/TYPE lines, counters and escaped labels', () => {
    const text = toPrometheus(snapshot(), { labels: { bot: 'ventas' } })
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('# TYPE botwa_conversations_started_total counter')
    expect(text).toContain('botwa_conversations_started_total{bot="ventas"} 1')
    expect(text).toContain('botwa_conversations_active{bot="ventas"} 2')
    expect(text).toContain('botwa_conversations_ended_total{bot="ventas",outcome="completed"} 1')
    expect(text).toContain('botwa_flow_started_total{bot="ventas",flow="re\\"g\\\\x\\n"} 1')
    expect(text).toContain('botwa_flow_duration_avg_seconds{bot="ventas",flow="re\\"g\\\\x\\n"} 1.5')
    expect(text).toContain('botwa_messages_out_total{bot="ventas",result="failed"} 1')
    expect(text).toContain('botwa_inbound_dropped_total{bot="ventas",reason="duplicate"} 1')
    expect(text).toContain('botwa_errors_total{bot="ventas"} 1')
    expect(text).toContain('botwa_uptime_seconds{bot="ventas"} 0')
    // every sample line is "name{labels} value" or "name value"
    for (const line of text.trim().split('\n')) {
      if (line.startsWith('#')) continue
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? \S+$/)
    }
  })

  it('supports a custom prefix and validates names', () => {
    expect(toPrometheus(snapshot(), { prefix: 'mybot_' })).toContain('mybot_messages_in_total 1')
    expect(() => toPrometheus(snapshot(), { prefix: '1bad' })).toThrow(TypeError)
    expect(() => toPrometheus(snapshot(), { labels: { 'bad-name': 'x' } })).toThrow(TypeError)
  })
})
