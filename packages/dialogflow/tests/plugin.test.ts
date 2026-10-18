import { describe, expect, it } from 'vitest'
import { flow } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'
import { DialogflowContext, dialogflowContext, dialogflowPlugin, toSessionId, whenDialogflowIntent, type DialogflowPluginConfig } from '../src/index.js'
import { FakeGoogle, credentials, esResponse, type RecordedRequest } from './fakes.js'

const flush = () => new Promise((r) => setTimeout(r, 20))
const textOf = (req: RecordedRequest) => (JSON.parse(req.body) as { queryInput: { text: { text: string } } }).queryInput.text.text

/** Fake agent: a few canned intents keyed by the query text. */
function agent(google: FakeGoogle): void {
  google.detect = (req) => {
    const text = textOf(req)
    if (text.startsWith('pedido')) return { json: esResponse('order.status', { order: text.split(' ')[1] ?? '' }, { text: 'Consultando…' }) }
    if (text === 'reservar') return { json: esResponse('book.table', { people: 2, date: '2026-10-20' }) }
    if (text === 'hola') return { json: esResponse('greeting', {}, { text: '¡Hola! Soy el agente.' }) }
    if (text === 'dudoso') return { json: esResponse('greeting', {}, { confidence: 0.2, text: 'meh' }) }
    return { json: esResponse('Default Fallback Intent', {}, { fallback: true, text: 'No entendí' }) }
  }
}

async function setup(extra: Partial<DialogflowPluginConfig> = {}) {
  const google = new FakeGoogle()
  agent(google)
  const t = await createTestBot()
  t.bot.plug(dialogflowPlugin({ credentials, http: google.http, ...extra }))
  const df = t.bot.injectTools.dialogflow!
  return { ...t, google, df }
}

describe('dialogflowPlugin — routing', () => {
  it('routes an intent to a handler with the result; unmatched text falls through to onMessage', async () => {
    const { bot, chat, df, google } = await setup()
    expect(df).toBeInstanceOf(DialogflowContext)
    whenDialogflowIntent(bot, df, 'order.status', (ctx, r) => ctx.reply(`pedido=${String(r.parameters.order)} (${r.intent})`))
    bot.onMessage((ctx) => ctx.reply('fallback'))

    await chat.send('pedido 42')
    await chat.expectReply('pedido=42 (order.status)')
    await chat.send('asdf')
    await chat.expectReply('fallback')
    expect(google.detectRequests()).toHaveLength(2)
    expect(google.tokenCalls).toBe(1)
    await bot.stop()
  })

  it('routes an intent to a flow and copies the parameters into c.state', async () => {
    const { bot, chat, df } = await setup()
    const booking = flow('reservation')
      .say((_ctx, c) => `Reserva para ${String(c.state.people)} el ${String(c.state.date)}`)
      .ask('¿A nombre de quién?', 'name')
      .say((_ctx, c) => `Listo ${String(c.state.name)}, ${String(c.state.people)} personas`)
    whenDialogflowIntent(bot, df, 'book.table', booking)

    await chat.send('reservar')
    await chat.expectReply('Reserva para 2 el 2026-10-20')
    await chat.expectReply('¿A nombre de quién?')
    await chat.send('Ana')
    await chat.expectReply('Listo Ana, 2 personas')
    await bot.stop()
  })

  it('stateKey nests the parameters; config.routes registers routes at install', async () => {
    const booking = flow('reservation').say((_ctx, c) => `params=${JSON.stringify(c.state.df)}`)
    const { bot, chat } = await setup({ routes: { 'book.table': booking, greeting: (ctx) => ctx.reply('hi from route') } })
    await chat.send('hola')
    await chat.expectReply('hi from route')
    await bot.stop()

    const s2 = await setup()
    whenDialogflowIntent(s2.bot, s2.df, ['book.table'], booking, { stateKey: 'df' })
    await s2.chat.send('reservar')
    await s2.chat.expectReply('params={"people":2,"date":"2026-10-20"}')
    await s2.bot.stop()
  })

  it('respects minConfidence and the unsubscribe function', async () => {
    const { bot, chat, df } = await setup({ minConfidence: 0.5 })
    const off = whenDialogflowIntent(bot, df, 'greeting', (ctx) => ctx.reply('saludo'))
    bot.onMessage((ctx) => ctx.reply('fallback'))
    await chat.send('dudoso')
    await chat.expectReply('fallback')
    await chat.send('hola')
    await chat.expectReply('saludo')
    off()
    await chat.send('hola')
    await chat.expectReply('fallback')
    expect(chat.replies()).toEqual(['fallback', 'saludo', 'fallback'])
    await bot.stop()
  })
})

describe('dialogflowPlugin — what is sent to Dialogflow', () => {
  it('skips commands and messages inside an active conversation', async () => {
    const { bot, chat, google, df } = await setup()
    bot.command('help', (ctx) => ctx.reply('ayuda'))
    bot.conversation('quiz', async (c) => {
      const a = await c.ask('¿2+2?')
      await c.say(`dijiste ${a}`)
    }, { trigger: 'quiz' })
    whenDialogflowIntent(bot, df, 'greeting', (ctx) => ctx.reply('saludo'))

    await chat.send('/help')
    await chat.expectReply('ayuda')
    await chat.send('quiz')
    await chat.expectReply('¿2+2?')
    await chat.send('hola')
    await chat.expectReply('dijiste hola')
    // Only "quiz" reached Dialogflow: "/help" is a command, "hola" was a conversation answer.
    expect(google.detectRequests().map(textOf)).toEqual(['quiz'])
    await bot.stop()
  })

  it('skips chats that are handed off to a human, and detects again after resume', async () => {
    const { bot, chat, google } = await setup()
    await bot.handoff(chat.jid)
    await chat.send('hola')
    await flush()
    expect(google.detectRequests()).toHaveLength(0)

    await bot.resume(chat.jid)
    await chat.send('hola')
    await flush()
    expect(google.detectRequests().map(textOf)).toEqual(['hola'])
    await bot.stop()
  })

  it('uses one hashed session per chat by default, per participant on request', async () => {
    const { bot, provider, google } = await setup()
    provider.incoming('hola', { from: 'g1', sender: 'u1', isGroup: true })
    provider.incoming('hola', { from: 'g1', sender: 'u2', isGroup: true })
    await flush()
    const urls = google.detectRequests().map((r) => r.url)
    expect(urls[0]).toContain(`/sessions/${toSessionId('g1')}:detectIntent`)
    expect(urls[1]).toBe(urls[0])
    await bot.stop()

    const s2 = await setup({ sessionScope: 'participant' })
    s2.provider.incoming('hola', { from: 'g1', sender: 'u1', isGroup: true })
    s2.provider.incoming('hola', { from: 'g1', sender: 'u2', isGroup: true })
    await flush()
    const [a, b] = s2.google.detectRequests().map((r) => r.url)
    expect(a).not.toBe(b)
    await s2.bot.stop()
  })

  it('passes languageFor / queryParams per message and honours filter', async () => {
    const { bot, chat, google } = await setup({
      languageFor: () => 'en',
      queryParams: (ctx) => ({ payload: { chat: ctx.from.length } }),
      filter: (ctx) => ctx.body !== 'secreto',
    })
    await chat.send('hola')
    await chat.send('secreto')
    await flush()
    const reqs = google.detectRequests()
    expect(reqs).toHaveLength(1)
    expect(JSON.parse(reqs[0].body)).toMatchObject({ queryInput: { text: { languageCode: 'en' } }, queryParams: { payload: { chat: chat.jid.length } } })
    await bot.stop()
  })

  it('a failed detectIntent is reported and the message still reaches other handlers', async () => {
    const errors: unknown[] = []
    const { bot, chat, google } = await setup({ onError: (e) => errors.push(e) })
    google.detect = () => ({ status: 500, json: { error: { message: 'boom', status: 'INTERNAL' } } })
    bot.onMessage((ctx) => ctx.reply('sigo vivo'))
    await chat.send('hola')
    await chat.expectReply('sigo vivo')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ name: 'DialogflowError', code: 'INTERNAL' })
    await bot.stop()
  })
})

describe('dialogflowPlugin — fulfillment auto-reply', () => {
  it("'unrouted' replies with the agent's text for matched intents without a route only", async () => {
    const { bot, chat, df } = await setup({ fulfillment: 'unrouted' })
    whenDialogflowIntent(bot, df, 'order.status', (ctx) => ctx.reply('ruta propia'))
    bot.onMessage((ctx) => ctx.reply('fallback'))
    await chat.send('hola')
    await chat.expectReply('¡Hola! Soy el agente.')
    await chat.send('pedido 1')
    await chat.expectReply('ruta propia')
    await chat.send('asdf')
    await chat.expectReply('fallback')
    expect(chat.replies()).toEqual(['¡Hola! Soy el agente.', 'ruta propia', 'fallback'])
    await bot.stop()
  })

  it("'all' also answers the fallback intent", async () => {
    const { bot, chat } = await setup({ fulfillment: 'all' })
    bot.onMessage((ctx) => ctx.reply('fallback'))
    await chat.send('asdf')
    await chat.expectReply('No entendí')
    await bot.stop()
  })
})

describe('dialogflowContext alias / install', () => {
  it('is the same factory and fails synchronously at plug() on a broken key', async () => {
    expect(dialogflowContext).toBe(dialogflowPlugin)
    const { bot } = await createTestBot()
    expect(() => bot.plug(dialogflowContext({ credentials: { ...credentials, private_key: 'x' } }))).toThrow(/private_key/)
    await bot.stop()
  })
})

describe('whenDialogflowIntent — flow identity', () => {
  it('the wrapped flow does not collide with the same flow registered elsewhere', async () => {
    const { bot, chat, df } = await setup()
    const book = flow('book').say((_ctx, c) => `people=${String(c.state.people)}`)
    whenDialogflowIntent(bot, df, 'book.table', book)
    bot.when('reservar ya', book)

    await chat.send('reservar')
    await chat.expectReply('people=2')
    await chat.send('reservar ya')
    await chat.expectReply('people=undefined')
    await bot.stop()
  })

  it('two routes with different stateKey on the same flow keep their own injection', async () => {
    const { bot, chat, df } = await setup()
    const show = flow('show').say((_ctx, c) => `a=${JSON.stringify(c.state.a)} b=${JSON.stringify(c.state.b)}`)
    whenDialogflowIntent(bot, df, 'book.table', show, { stateKey: 'a' })
    whenDialogflowIntent(bot, df, 'order.status', show, { stateKey: 'b' })

    await chat.send('reservar')
    await chat.expectReply('a={"people":2,"date":"2026-10-20"} b=undefined')
    await bot.stop()
  })
})
