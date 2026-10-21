import { describe, expect, it } from 'vitest'
import { createTestBot, MockProvider, type MockOutgoing } from '../src/testing/index.js'
import { botMatchers, type BotMatcherContext } from '../src/testing/vitest/index.js'

expect.extend(botMatchers)

const outbox: MockOutgoing[] = [
  { chatId: 'a', content: { kind: 'text', text: 'Hola Ana' } },
  { chatId: 'a', content: { kind: 'image', media: { url: 'https://x/a.png' }, caption: 'foto' } },
  { chatId: 'a', content: { kind: 'buttons', text: 'Elige', buttons: [{ id: 'a', title: 'A' }] } },
]

describe('botMatchers', () => {
  it('toHaveReplied matches text includes / regexp on every receiver kind', async () => {
    expect(outbox).toHaveReplied('Ana')
    expect(outbox).toHaveReplied(/^foto$/)
    expect(outbox).not.toHaveReplied('adiós')
    expect(['uno', 'dos']).toHaveReplied('dos')
    expect(['uno']).not.toHaveReplied(/tres/)

    const provider = new MockProvider()
    await provider.send('a', { kind: 'text', text: 'desde el mock' })
    expect(provider).toHaveReplied('mock')

    const { bot, chat } = await createTestBot()
    bot.when('hola', async (ctx) => await ctx.reply('👋 hola'))
    await chat.send('hola')
    await chat.expectReply('hola')
    expect(chat).toHaveReplied('👋')
    expect(chat).toHaveRepliedTimes(1)
    expect(chat).toHaveRepliedMatching((text, content) => content.kind === 'text' && text.startsWith('👋'))
    await bot.stop()
  })

  it('toHaveRepliedMatching accepts a regexp or a predicate over text and content', () => {
    expect(outbox).toHaveRepliedMatching(/Elige/)
    expect(outbox).toHaveRepliedMatching((_text, content) => content.kind === 'image')
    expect(outbox).not.toHaveRepliedMatching((_text, content) => content.kind === 'poll')
  })

  it('toHaveRepliedTimes counts every outbound entry', () => {
    expect(outbox).toHaveRepliedTimes(3)
    expect(outbox).not.toHaveRepliedTimes(2)
    expect([]).toHaveRepliedTimes(0)
  })

  it('produces readable failure messages, also under .not', () => {
    const ctx: BotMatcherContext = { isNot: false }
    const miss = botMatchers.toHaveReplied.call(ctx, outbox, 'adiós')
    expect(miss.pass).toBe(false)
    expect(miss.message()).toMatch(/expected a reply including "adiós"/)
    expect(miss.message()).toMatch(/"Hola Ana"/)
    const hit = botMatchers.toHaveReplied.call({ isNot: true }, outbox, 'Ana')
    expect(hit.pass).toBe(true)
    expect(hit.message()).toMatch(/expected no reply including "Ana"/)
    const times = botMatchers.toHaveRepliedTimes.call(ctx, outbox, 2)
    expect(times.message()).toMatch(/expected 2 replies, got 3/)
    const matching = botMatchers.toHaveRepliedMatching.call(ctx, outbox, /nada/)
    expect(matching.message()).toMatch(/expected a reply matching \/nada\//)
    expect(() => expect(outbox).toHaveReplied('adiós')).toThrow(/expected a reply including "adiós"/)
  })

  it('fails (never throws) on a receiver that is not a replies source', () => {
    const result = botMatchers.toHaveReplied.call({ isNot: false }, 42, 'x')
    expect(result.pass).toBe(false)
    expect(result.message()).toMatch(/toHaveReplied expects a TestChat, MockProvider, outbox array or string\[\]/)
    expect(() => expect(42).toHaveReplied('x')).toThrow(/expects a TestChat/)
    expect(botMatchers.toHaveRepliedTimes.call({ isNot: false }, { nope: true }, 1).pass).toBe(false)
  })

  it('uses the matcher utils to print values when present', () => {
    const printed: unknown[] = []
    const ctx: BotMatcherContext = { isNot: false, utils: { printReceived: (v) => { printed.push(v); return '<received>' } } }
    const result = botMatchers.toHaveReplied.call(ctx, ['a'], 'b')
    expect(result.message()).toBe('expected a reply including "b", got: <received>')
    expect(printed).toEqual([['a']])
  })
})
