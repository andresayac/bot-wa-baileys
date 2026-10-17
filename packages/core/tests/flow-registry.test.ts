import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('dynamic flow registry (bot.registerFlow / unregisterFlow / replaceFlow / listFlows)', () => {
  it('registers a flow at runtime and routes its trigger', async () => {
    const { bot, chat } = await createTestBot()
    const id = bot.registerFlow(flow('encuesta').say('v1'))
    expect(id).toBe('encuesta')
    expect(bot.hasFlow('encuesta')).toBe(true)
    await chat.send('encuesta')
    await chat.expectReply('v1')
    await bot.stop()
  })

  it('refuses to register a duplicate id', async () => {
    const { bot } = await createTestBot()
    bot.registerFlow(flow('dup').say('a'))
    expect(() => bot.registerFlow(flow('dup').say('b'))).toThrow(/already registered/)
    await bot.stop()
  })

  it('unregisters a flow: its trigger stops matching', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(flow('menu').say('menu!'))
    expect(bot.unregisterFlow('menu')).toBe(true)
    expect(bot.unregisterFlow('menu')).toBe(false)
    expect(bot.hasFlow('menu')).toBe(false)
    await chat.send('menu')
    await tick()
    expect(chat.replies()).toEqual([])
    expect(bot.listFlows().map((f) => f.id)).not.toContain('menu')
    await bot.stop()
  })

  it('can unregister flows registered with bot.use()', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('legacy').say('old'))
    expect(bot.unregisterFlow('legacy')).toBe(true)
    await chat.send('legacy')
    await tick()
    expect(chat.replies()).toEqual([])
    await bot.stop()
  })

  it('replaceFlow hot-swaps the steps and trigger under the same id', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(flow('promo').say('v1'))
    bot.replaceFlow('promo', flow('oferta').say('v2'))
    await chat.send('promo')
    await tick()
    expect(chat.replies()).toEqual([])
    await chat.send('oferta')
    await chat.expectReply('v2')
    expect(bot.listFlows().filter((f) => f.id === 'promo')).toHaveLength(1)
    await bot.stop()
  })

  it('replaceFlow keeps a running conversation on its old version', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(flow('quiz').ask('¿nombre?', 'name').say((_ctx, c) => `old ${String(c.state.name)}`))
    await chat.send('quiz')
    await chat.expectReply('¿nombre?')
    bot.replaceFlow('quiz', flow('quiz').say('new'))
    await chat.send('Ana')
    await chat.expectReply('old Ana')
    await chat.send('quiz')
    await chat.expectReply('new')
    await bot.stop()
  })

  it('listFlows describes flows and conversations', async () => {
    const { bot } = await createTestBot()
    bot.registerFlow(flow('a').say('x').ask('y', 'k').persistent())
    bot.conversation('conv', async () => {})
    const list = bot.listFlows()
    expect(list).toContainEqual({ id: 'a', kind: 'flow', steps: 2, persistent: true })
    expect(list).toContainEqual({ id: 'conv', kind: 'conversation' })
    await bot.stop()
  })

  it('triggerFlow starts a flow proactively in a chat, seeding state', async () => {
    const { bot, chat, provider } = await createTestBot()
    bot.registerFlow(flow('saludo').say((_ctx, c) => `hola ${String(c.state.name)}`).ask('¿edad?', 'age').say((_c, c) => `ok ${String(c.state.age)}`))
    expect(bot.triggerFlow('saludo', { chatId: chat.jid }, { state: { name: 'Bea' } })).toBe(true)
    await chat.expectReply('hola Bea')
    await chat.expectReply('¿edad?')
    expect(bot.listConversations().map((c) => c.key)).toEqual([chat.jid])
    await chat.send('30')
    await chat.expectReply('ok 30')
    expect(bot.triggerFlow('missing', { chatId: chat.jid })).toBe(false)
    expect(provider.outbox.length).toBeGreaterThan(0)
    await bot.stop()
  })

  it('listConversations lists live conversations; abortConversation cancels one', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(flow('q').ask('?', 'a'))
    await chat.send('q')
    await chat.expectReply('?')
    const [snap] = bot.listConversations()
    expect(snap).toMatchObject({ key: chat.jid, waiting: true })
    expect(bot.abortConversation(snap.key)).toBe(true)
    expect(bot.listConversations()).toEqual([])
    await bot.stop()
  })
})
