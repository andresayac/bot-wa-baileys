/**
 * Type-level contract of `bot.conversation()`: `ctx` is the full MessageContext (with the
 * `DefaultTools` augmentation), not the runtime's minimal RuntimeMessage. The `expectTypeOf`
 * assertions and `@ts-expect-error` lines are enforced by `pnpm typecheck` (tsconfig.test.json
 * includes tests/); the runtime assertions run under vitest as usual.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import type {
  ConversationControls,
  ConversationFn,
  ConversationHandler,
  IdleCallback,
  MessageContext,
  RuntimeMessage,
  SentMessage,
} from '../src/index.js'

// A plugin-style augmentation (what `@bot-wa/nlu` does for `ctx.tools.nlu`).
declare module '../src/core/provider.js' {
  interface DefaultTools {
    /** Test-only tool used to prove the augmentation reaches conversation contexts. */
    typingProbe?: { ping(): string }
  }
}

describe('bot.conversation() typing', () => {
  it('types ctx as the full MessageContext (tools, media helpers, reactions…)', async () => {
    const { bot, chat } = await createTestBot()
    bot.provide('typingProbe', { ping: () => 'pong' })

    bot.conversation('tipos', async (c, ctx) => {
      expectTypeOf(ctx).not.toBeAny()
      expectTypeOf(ctx).toEqualTypeOf<MessageContext>()
      expectTypeOf(c).toEqualTypeOf<ConversationControls>()
      expectTypeOf(ctx.tools.typingProbe).toEqualTypeOf<{ ping(): string } | undefined>()
      expectTypeOf(ctx.photo).returns.toEqualTypeOf<Promise<SentMessage>>()
      expectTypeOf(ctx.poll).toBeFunction()
      expectTypeOf(ctx.react).parameter(0).toEqualTypeOf<string>()
      expectTypeOf(ctx.senderInfo.id).toBeString()
      // @ts-expect-error — ctx is not `any`: unknown members are rejected
      void ctx.definitelyNotAMember

      // Runtime: it really is the full context.
      expect(typeof ctx.photo).toBe('function')
      expect(typeof ctx.poll).toBe('function')
      await ctx.react('👍')
      await ctx.reply(ctx.tools.typingProbe?.ping() ?? 'sin probe')
    })

    await chat.send('tipos')
    await chat.expectReply('pong')
  })

  it('exposes retry/idle on the controls with precise signatures', () => {
    expectTypeOf<ConversationControls['retry']>().toBeFunction()
    expectTypeOf<ReturnType<ConversationControls['idleClear']>>().toEqualTypeOf<void>()
    expectTypeOf<ConversationControls['idle']>().parameter(1).toEqualTypeOf<IdleCallback>()
    // Type-only: never executed (there is no live conversation here).
    const typeOnly = (c: ConversationControls) => {
      expectTypeOf(c.retry()).toEqualTypeOf<Promise<string>>()
      expectTypeOf(c.retry<RuntimeMessage>('otra')).toEqualTypeOf<Promise<RuntimeMessage>>()
    }
    expect(typeof typeOnly).toBe('function')
  })

  it('ConversationHandler is the public handler type; old ConversationFn handlers still compile', async () => {
    const { bot, chat } = await createTestBot()
    const typed: ConversationHandler = async (_c, ctx) => { await ctx.quote('citado') }
    expectTypeOf(typed).parameter(1).toEqualTypeOf<MessageContext>()

    // Backwards compatible: a handler written against the minimal RuntimeMessage still fits.
    const legacy: ConversationFn<ConversationControls> = async (_c, ctx) => { await ctx.reply('legacy ok') }
    bot.conversation('legacy', legacy)
    bot.conversation('typed', typed)
    // A handler that returns the reply's promise (Promise<SentMessage>) is accepted too.
    bot.conversation('expr', async (_c, ctx) => ctx.reply('expr ok'))

    await chat.send('legacy')
    await chat.expectReply('legacy ok')
    await chat.send('typed')
    await chat.expectReply('citado')
    await chat.send('expr')
    await chat.expectReply('expr ok')
  })
})
