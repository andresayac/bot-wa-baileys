/**
 * Type-level contract: importing `@bot-wa/ai` augments `@bot-wa/core`'s
 * `DefaultTools`, so `ctx.tools.ai` is an {@link AIClient} in handlers without
 * casts. The `expectTypeOf` assertions (and the plain `ctx.tools.ai.ask(...)`
 * calls) are enforced by `pnpm typecheck`; the runtime half proves the typed
 * value really is the client the plugin injected.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { DefaultTools, MessageContext, PluginContext } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'
// The public entry is what carries the augmentation.
import { AIClient, MockAIProvider, aiPlugin } from '../src/index.js'

describe('ctx.tools.ai typing (DefaultTools augmentation)', () => {
  it('DefaultTools declares ai as a required AIClient', () => {
    expectTypeOf<DefaultTools>().toHaveProperty('ai').toEqualTypeOf<AIClient>()
    expectTypeOf<MessageContext['tools']['ai']>().toEqualTypeOf<AIClient>()
    expectTypeOf<PluginContext['tools']['ai']>().toEqualTypeOf<AIClient>()
  })

  it('types ctx.tools.ai.ask inside bot.when handlers', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'IA responde' }), autoReply: false }))
    bot.when('q', async (ctx) => {
      expectTypeOf(ctx.tools.ai).toEqualTypeOf<AIClient>()
      expectTypeOf(ctx.tools.ai.ask).parameter(0).toEqualTypeOf<string>()
      expect(ctx.tools.ai).toBeInstanceOf(AIClient)
      const a = await ctx.tools.ai.ask('algo')
      expectTypeOf(a).toEqualTypeOf<string>()
      await ctx.reply(`ai dijo: ${a}`)
    })
    await chat.send('q')
    await chat.expectReply('ai dijo: IA responde')
  })

  it('types ctx.tools.ai in onMessage and command handlers', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'IA responde' }), autoReply: false, resetCommand: false }))
    bot.command('resume', async (ctx, args) => {
      const a = await ctx.tools.ai.ask(args.join(' '))
      await ctx.reply(`cmd: ${a}`)
    })
    bot.onMessage(async (ctx) => {
      const a = await ctx.tools.ai.ask(ctx.body)
      await ctx.reply(`catch-all: ${a}`)
    })
    await chat.send('/resume esto')
    await chat.expectReply('cmd: IA responde')
    await chat.send('otra cosa')
    await chat.expectReply('catch-all: IA responde')
  })

  it('types ctx.tools.ai inside bot.conversation (README example)', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'resumen' }), autoReply: false }))
    // Same shape as the packages/ai/README.md conversation example.
    bot.conversation('reclamo', async (c, ctx) => {
      expectTypeOf(ctx.tools.ai).toEqualTypeOf<AIClient>()
      await ctx.reply('📝 Cuéntanos qué pasó con tu pedido:')
      const texto = await c.waitText()
      const resumen = await ctx.tools.ai.ask(
        `Resume en 3 líneas este reclamo de un cliente para el equipo de soporte: ${texto}`,
      )
      await ctx.reply(`✅ Registramos tu reclamo:\n${resumen}`)
    })
    await chat.send('reclamo')
    await chat.expectReply('📝 Cuéntanos qué pasó con tu pedido:')
    await chat.send('llegó roto')
    await chat.expectReply('✅ Registramos tu reclamo:\nresumen')
  })
})
