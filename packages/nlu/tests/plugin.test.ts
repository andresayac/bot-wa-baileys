import { describe, expect, it } from 'vitest'
import { createTestBot } from '@botmesh/core/testing'
import { IntentEngine, nluPlugin, whenIntent } from '../src/index.js'

describe('whenIntent — Bot integration', () => {
  it('routes each message to its intent handler; unmatched text falls through to onMessage', async () => {
    const { bot, chat } = await createTestBot()
    const nlu = new IntentEngine()
      .define('greeting', ['hola', 'buenas'])
      .define('order.status', ['mi pedido {id}', 'estado de mi pedido'])

    whenIntent(bot, nlu, 'greeting', (ctx) => ctx.reply('👋 saludo'))
    whenIntent(bot, nlu, 'order.status', (ctx, m) => ctx.reply(`pedido:${m.entities?.id ?? 'sin-id'}`))
    bot.onMessage((ctx) => ctx.reply('fallback'))

    await chat.send('¡Hola!')
    await chat.expectReply('👋 saludo')

    await chat.send('mi pedido 123')
    await chat.expectReply('pedido:123')

    await chat.send('estado de mi pedido')
    await chat.expectReply('pedido:sin-id')

    // Nothing matches any intent → falls through every whenIntent to onMessage.
    await chat.send('xyzzy nada que ver')
    await chat.expectReply('fallback')

    expect(chat.replies()).toEqual(['👋 saludo', 'pedido:123', 'pedido:sin-id', 'fallback'])
    await bot.stop()
  })

  it('a handler only consumes messages whose BEST match is its own intent', async () => {
    const { bot, chat } = await createTestBot()
    const nlu = new IntentEngine()
      .define('greeting', ['hola'])
      .define('order.status', ['estado de mi pedido'])

    whenIntent(bot, nlu, 'greeting', (ctx) => ctx.reply('only-greeting'))
    // Note: no whenIntent registered for order.status — those messages fall through.
    bot.onMessage((ctx) => ctx.reply('fallback'))

    // Best match is order.status, so the greeting handler must NOT fire.
    await chat.send('hola quiero el estado de mi pedido')
    await chat.expectReply('fallback')

    await chat.send('hola')
    await chat.expectReply('only-greeting')

    expect(chat.replies()).toEqual(['fallback', 'only-greeting'])
    await bot.stop()
  })

  it('returns an unsubscribe function that detaches the matcher', async () => {
    const { bot, chat } = await createTestBot()
    const nlu = new IntentEngine().define('greeting', ['hola'])
    const off = whenIntent(bot, nlu, 'greeting', (ctx) => ctx.reply('intent-reply'))
    bot.onMessage((ctx) => ctx.reply('fallback'))

    await chat.send('hola')
    await chat.expectReply('intent-reply')

    off()
    await chat.send('hola')
    await chat.expectReply('fallback')
    await bot.stop()
  })
})

describe('nluPlugin', () => {
  it('exposes the engine as ctx.tools.nlu and seeds intents from config', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(nluPlugin, {
      threshold: 0.5,
      intents: { greeting: ['hola', 'buenas'], 'order.status': ['mi pedido {id}'] },
    })

    const nlu = bot.injectTools.nlu
    expect(nlu).toBeInstanceOf(IntentEngine)
    expect(nlu?.intents()).toEqual(['greeting', 'order.status'])

    whenIntent(bot, nlu!, 'order.status', (ctx, m) => ctx.reply(`id=${m.entities?.id}`))
    bot.onMessage((ctx) => {
      // ctx.tools.nlu is typed through the @botmesh/core module augmentation.
      const viaCtx = ctx.tools.nlu
      return ctx.reply(`unmatched:${viaCtx ? viaCtx.intents().join('+') : 'no-engine'}`)
    })

    await chat.send('mi pedido 777')
    await chat.expectReply('id=777')

    await chat.send('otra cosa')
    await chat.expectReply('unmatched:greeting+order.status')
    await bot.stop()
  })

  it('works with no config (empty engine) and honors a custom threshold', async () => {
    const { bot } = await createTestBot()
    bot.plug(nluPlugin)
    const nlu = bot.injectTools.nlu
    expect(nlu).toBeInstanceOf(IntentEngine)
    expect(nlu?.intents()).toEqual([])
    expect(nlu?.match('hola')).toBeNull()

    // Re-plugging replaces the provided engine.
    bot.plug(nluPlugin, { threshold: 0.9, intents: { g: ['hola'] } })
    expect(bot.injectTools.nlu?.threshold).toBe(0.9)
    expect(bot.injectTools.nlu?.match('hola')?.confidence).toBe(1)
    await bot.stop()
  })
})
