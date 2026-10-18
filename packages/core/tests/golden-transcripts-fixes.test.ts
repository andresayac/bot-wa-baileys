import { describe, expect, it } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { IProvider } from '../src/core/provider.js'
import {
  MockProvider,
  createTranscript,
  parseTranscript,
  recordTranscript,
  redactTranscript,
  replayTranscript,
  serializeTranscript,
  transcriptFromStore,
  type Transcript,
} from '../src/testing/index.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** A bot that prints its own digit runs, greets by display name and validates emails/phones. */
function shopBot() {
  return (provider: IProvider): Bot => {
    const bot = new Bot({ provider })
    bot.when('pedido', async (ctx) => { await ctx.reply('Tu pedido 1234567 llega el 2026-10-18') })
    bot.when('precio', async (ctx) => { await ctx.reply('Cuesta 1.250.000 COP') })
    bot.when('hola', async (ctx) => { await ctx.reply(`Hola ${ctx.pushName ?? ''}`) })
    bot.when((ctx) => /^\S+@\S+\.\S+$/.test(ctx.body), async (ctx) => { await ctx.reply(`Email válido: ${ctx.body}`) })
    bot.when((ctx) => /^\+\d{8,}$/.test(ctx.body), async (ctx) => { await ctx.reply(`Te llamamos al ${ctx.body}`) })
    return bot
  }
}

async function record(drive: (mock: MockProvider) => Promise<void>): Promise<Transcript> {
  const mock = new MockProvider()
  const recorder = recordTranscript(mock)
  const bot = shopBot()(recorder.provider)
  await bot.start()
  await drive(mock)
  await tick(40)
  await bot.stop()
  return recorder.transcript({ name: 'shop' })
}

describe('golden transcripts — redaction vs replay', () => {
  it('does not redact digit runs the bot prints itself, so the golden replays', async () => {
    const recorded = await record(async (mock) => {
      mock.incoming('pedido', { from: 'u1' }); await tick()
      mock.incoming('precio', { from: 'u1' }); await tick()
    })
    const red = redactTranscript(recorded)
    expect(red.turns.filter((turn) => turn.dir === 'out').map((turn) => turn.text)).toEqual([
      'Tu pedido 1234567 llega el 2026-10-18', 'Cuesta 1.250.000 COP',
    ])
    const result = await replayTranscript(parseTranscript(serializeTranscript(red)), shopBot())
    expect(result.report()).toBe('✓ transcript "shop" matches')
  })

  it('still redacts user-derived values echoed in replies', async () => {
    const recorded = await record(async (mock) => {
      mock.incoming('+573001112233', { from: 'u1' }); await tick()
    })
    const red = redactTranscript(recorded)
    expect(red.turns.map((turn) => turn.text)).toEqual(['<phone:1>', 'Te llamamos al <phone:1>'])
    expect(JSON.stringify(red)).not.toContain('3001112233')
  })

  it('outboundPatterns redacts bot-printed values; replay tolerates them by category with redact', async () => {
    const recorded = await record(async (mock) => {
      mock.incoming('pedido', { from: 'u1' }); await tick()
    })
    const red = redactTranscript(recorded, { outboundPatterns: true })
    expect(red.turns[1].text).toBe('Tu pedido <phone:1> llega el <phone:2>')
    expect((await replayTranscript(red, shopBot())).ok).toBe(false)
    const result = await replayTranscript(red, shopBot(), { redact: { phones: true } })
    expect(result.report()).toBe('✓ transcript "shop" matches')
  })

  it('surrogates keep redacted inbound values format-valid for validation steps', async () => {
    const recorded = await record(async (mock) => {
      mock.incoming('ana@mail.com', { from: 'u1' }); await tick()
      mock.incoming('+573001112233', { from: 'u1' }); await tick()
    })
    expect((await replayTranscript(redactTranscript(recorded), shopBot(), { stepTimeoutMs: 200 })).ok).toBe(false)
    const red = redactTranscript(recorded, { surrogates: true })
    expect(red.turns.map((turn) => turn.text)).toEqual([
      'email1@redacted.invalid', 'Email válido: email1@redacted.invalid', '+10000000001', 'Te llamamos al +10000000001',
    ])
    expect(JSON.stringify(red)).not.toMatch(/ana@mail|3001112233/)
    expect(redactTranscript(red, { surrogates: true })).toEqual(red)
    expect((await replayTranscript(red, shopBot())).ok).toBe(true)
  })

  it('replaces display names with placeholders everywhere and replays them as pushName', async () => {
    const recorded = await record(async (mock) => {
      mock.incoming('hola', { from: 'u1', pushName: 'Andres Aya' }); await tick()
    })
    const red = redactTranscript(recorded)
    expect(red.turns[0]).toMatchObject({ displayName: '<name:1>' })
    expect(red.turns[1].text).toBe('Hola <name:1>')
    expect(JSON.stringify(red)).not.toContain('Andres')
    expect((await replayTranscript(parseTranscript(serializeTranscript(red)), shopBot())).ok).toBe(true)

    const dropped = redactTranscript(recorded, { displayNames: 'drop' })
    expect(dropped.turns[0]).not.toHaveProperty('displayName')
    expect(JSON.stringify(dropped)).not.toContain('Andres')
    expect(redactTranscript(recorded, { displayNames: 'keep' }).turns[0]).toMatchObject({ displayName: 'Andres Aya' })
  })

  it('replaces names on word boundaries only', () => {
    const red = redactTranscript(createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'soy Ana', displayName: 'Ana' },
      { dir: 'out', chatId: 'u', kind: 'text', text: 'Hola Ana, ¿banana o Anabel?' },
    ]))
    expect(red.turns.map((turn) => turn.text)).toEqual(['soy <name:1>', 'Hola <name:1>, ¿banana o Anabel?'])
  })

  it('does not replace message ids embedded in free text', () => {
    const red = redactTranscript(createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'precio', id: '1250' },
      { dir: 'out', chatId: 'u', kind: 'text', text: 'Cuesta 1250 COP' },
    ]))
    expect(red.turns[0]).toMatchObject({ id: '<msg:1>' })
    expect(red.turns[1].text).toBe('Cuesta 1250 COP')
  })
})

describe('golden transcripts — store source', () => {
  it('reads a bot store log in order, with the group kind, and replays it', async () => {
    const mock = new MockProvider()
    const bot = shopBot()(mock)
    await bot.start()
    mock.incoming('pedido', { from: 'g1', sender: 'u1', isGroup: true })
    await tick(5)
    mock.incoming('precio', { from: 'g1', sender: 'u1', isGroup: true })
    await tick(40)
    await bot.stop()
    const t = await transcriptFromStore(bot, 'g1')
    expect(t.turns.map((turn) => [turn.dir, turn.text, turn.dir === 'in' ? turn.isGroup : undefined])).toEqual([
      ['in', 'pedido', true], ['out', 'Tu pedido 1234567 llega el 2026-10-18', undefined],
      ['in', 'precio', true], ['out', 'Cuesta 1.250.000 COP', undefined],
    ])
    expect((await replayTranscript(t, shopBot())).ok).toBe(true)
    // An explicit chat kind wins over the store.
    expect((await transcriptFromStore(bot, 'g1', { isGroup: false })).turns[0]).not.toHaveProperty('isGroup')
  })

  it('persists second-precision inbound timestamps with millisecond precision when received live', async () => {
    const mock = new MockProvider()
    const bot = new Bot({ provider: mock })
    bot.when('a', async (ctx) => { await ctx.reply('r') })
    await bot.start()
    const before = Date.now()
    mock.incoming('a', { from: 'c' })
    await tick(30)
    await bot.stop()
    const [inbound] = await bot.getStore().getMessagesByChat('c')
    expect(inbound.timestamp).toBeGreaterThanOrEqual(before)
  })
})

describe('golden transcripts — recorder memory', () => {
  it('caps the recorder buffer with maxTurns', async () => {
    const mock = new MockProvider()
    const recorder = recordTranscript(mock, { maxTurns: 3 })
    const bot = new Bot({ provider: recorder.provider })
    await bot.start()
    for (const text of ['1', '2', '3', '4', '5']) { mock.incoming(text, { from: 'c' }); await tick(5) }
    await tick(20)
    await bot.stop()
    expect(recorder.transcript().turns.map((turn) => turn.text)).toEqual(['3', '4', '5'])
  })

  it('is bounded by default', () => {
    const recorder = recordTranscript(new MockProvider())
    expect(recorder.provider.maxTurns).toBe(10_000)
  })
})
