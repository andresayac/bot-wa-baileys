/**
 * api-review deferred items (alpha clean-ups): typed hook contexts (`HookContextMap`),
 * `Plugin.install` narrowed to a synchronous `void`, and `triggerFlow({ data })` with
 * `state` as a deprecated alias.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { definePlugin } from '../src/plugins/definePlugin.js'
import type {
  CallEvent, HookBeforeContext, HookContextOf, HookErrorHandler, HookHandler, MessageContext, PluginSpec, SendHookContext,
  SyncInstallError,
} from '../src/core/types.js'

declare module '../src/core/types.js' {
  interface HookContextMap {
    'crm.lead': { leadId: string }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('hook contexts are typed by the event name', () => {
  it('infers MessageContext / SendHookContext / CallEvent without annotations', async () => {
    const { bot, chat } = await createTestBot()
    const seen: string[] = []
    bot.before('message', async (ctx, next) => {
      expectTypeOf(ctx).toMatchTypeOf<HookBeforeContext<MessageContext>>()
      seen.push(`before:${ctx.body}`)
      await next()
    })
    bot.after('message', (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<MessageContext>()
      seen.push(`after:${ctx.type}`)
    })
    bot.before('send', async (payload, next) => {
      expectTypeOf(payload).toMatchTypeOf<HookBeforeContext<SendHookContext>>()
      if (payload.content.kind === 'text') payload.content.text = payload.content.text.toUpperCase()
      await next()
    })
    bot.after('send', (payload) => { seen.push(`sent:${payload.chatId}:${payload.content.kind}`) })
    bot.before('call', (event, next) => {
      expectTypeOf(event).toMatchTypeOf<HookBeforeContext<CallEvent>>()
      return next()
    })
    bot.onError('message', (ctx, error) => {
      expectTypeOf(ctx).toEqualTypeOf<MessageContext>()
      expectTypeOf(error).toEqualTypeOf<unknown>()
    })
    bot.hook('message', 'after', (ctx) => { expectTypeOf(ctx).toEqualTypeOf<MessageContext>() })
    bot.when('hola', (ctx) => ctx.reply('hi'))
    await chat.send('hola')
    await chat.expectReply('HI')
    expect(seen).toEqual(['before:hola', `sent:${chat.jid}:text`, 'after:text'])
    await bot.stop()
  })

  it('types a custom event as unknown, from the annotation, or from a HookContextMap augmentation', async () => {
    const bot = new Bot({ provider: new MockProvider() })
    bot.after('my.event', (ctx) => { expectTypeOf(ctx).toEqualTypeOf<unknown>() })
    bot.after('my.event', (ctx: { n: number }) => { expectTypeOf(ctx.n).toEqualTypeOf<number>() })
    bot.after<'my.event', { n: number }>('my.event', (ctx) => { expectTypeOf(ctx.n).toEqualTypeOf<number>() })
    bot.after('crm.lead', (lead) => { expectTypeOf(lead.leadId).toEqualTypeOf<string>() })
    expectTypeOf<HookContextOf<'crm.lead'>>().toEqualTypeOf<{ leadId: string }>()
    expectTypeOf<HookContextOf<'anything'>>().toEqualTypeOf<unknown>()
    // A handler typed for one event cannot be registered on another.
    const onMessage: HookHandler<MessageContext> = async (_ctx, next) => { await next() }
    // @ts-expect-error a MessageContext handler is not a 'send' handler
    bot.before('send', onMessage)
    bot.before('message', onMessage)
    // Supertype annotations keep working (contravariance).
    bot.before('send', async (p: { content: unknown }, next) => { void p.content; await next() })
    bot.before('message', async (ctx: { body: string; abort(): void }, next) => { void ctx.body; await next() })
    const onErr: HookErrorHandler = (_ctx, _error) => {}
    bot.onError('send', onErr)
    expect(typeof bot.before).toBe('function')
  })
})

describe('Plugin.install is synchronous and returns nothing', () => {
  it('rejects an async install at compile time and still routes its rejection at runtime', async () => {
    const { bot } = await createTestBot()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    // @ts-expect-error async install is not assignable to void | SyncInstallError
    definePlugin({ name: 'a', version: '1', async install() {} })
    // @ts-expect-error an install that returns a promise is rejected too
    definePlugin({ name: 'b', version: '1', install: () => Promise.resolve() })
    // @ts-expect-error a concise arrow that returns a value is rejected
    definePlugin({ name: 'c', version: '1', install: (ctx) => ctx.bot.when('x', () => {}) })
    class Sync implements PluginSpec { name = 'd'; version = '1'; install() {} }
    bot.plug(new Sync())
    const factory = (cfg?: { x?: number }) => definePlugin<{ x?: number }>({ name: 'e', version: '1', install(_ctx, c = cfg ?? {}) { void c.x } })
    bot.plug(factory())
    expectTypeOf<SyncInstallError>().toBeString()
    // A JavaScript plugin (no types) can still be async: the rejection reaches 'error', nothing crashes.
    const js = { name: 'js', version: '1', install: async () => { throw new Error('late') } } as unknown as PluginSpec
    bot.plug(js)
    await tick()
    expect(errors.map((e) => (e as Error).message)).toEqual(['late'])
    await bot.stop()
  })
})

describe('triggerFlow: data (state is a deprecated alias)', () => {
  const greet = () => flow('saludo').say((_ctx, c) => `hola ${String(c.state.name)}`)

  it('seeds c.state from data', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(greet())
    expect(await bot.triggerFlow('saludo', { chatId: chat.jid }, { data: { name: 'Bea' } })).toBe(true)
    await chat.expectReply('hola Bea')
    await bot.stop()
  })

  it('still honours the state alias', async () => {
    const { bot, chat } = await createTestBot()
    bot.registerFlow(greet())
    expect(await bot.triggerFlow('saludo', { chatId: chat.jid }, { state: { name: 'Ana' } })).toBe(true)
    await chat.expectReply('hola Ana')
    await bot.stop()
  })

  it('rejects data and state together with a TypeError, before the started-bot check', async () => {
    const stopped = new Bot({ provider: new MockProvider() })
    await expect(stopped.triggerFlow('x', { chatId: 'c' }, { data: { a: 1 }, state: { b: 2 } })).rejects.toThrow(TypeError)
    await expect(stopped.triggerFlow('x', { chatId: 'c' }, { data: { a: 1 }, state: { b: 2 } })).rejects.toThrow(/pass data/)
    await expect(stopped.triggerFlow('x', { chatId: 'c' }, { data: { a: 1 } })).rejects.toThrow(/started bot/)
    const { bot, chat } = await createTestBot()
    bot.registerFlow(greet())
    const same = { name: 'Eva' }
    expect(await bot.triggerFlow('saludo', { chatId: chat.jid }, { data: same, state: same })).toBe(true)
    await chat.expectReply('hola Eva')
    await bot.stop()
  })
})
