import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import type { PluginSpec } from '../src/core/types.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

const plugin = (name: string, over: Partial<PluginSpec> = {}): PluginSpec => ({
  name,
  version: '1.0.0',
  install() {},
  ...over,
})

describe('plugins: PluginSpec.requires', () => {
  it('refuses to plug a plugin whose required plugins are not installed, with a clear error', async () => {
    const { bot } = await createTestBot()
    let installed = false
    const dependent = plugin('crm', { requires: ['inbox', 'events'], install() { installed = true } })
    expect(() => bot.plug(dependent)).toThrow(/"crm" requires plugin\(s\) "inbox", "events"/)
    expect(installed).toBe(false)
    bot.plug(plugin('events'))
    expect(() => bot.plug(dependent)).toThrow(/requires plugin\(s\) "inbox", which is not plugged/)
    bot.plug(plugin('inbox'))
    expect(() => bot.plug(dependent)).not.toThrow()
    expect(installed).toBe(true)
    await bot.stop()
  })

  it('a requirement is satisfied only while the required plugin stays plugged', async () => {
    const { bot } = await createTestBot()
    const unplugBase = bot.plug(plugin('base'))
    bot.plug(plugin('a', { requires: ['base'] }))
    unplugBase()
    expect(() => bot.plug(plugin('b', { requires: ['base'] }))).toThrow(/requires plugin\(s\) "base"/)
    await bot.stop()
  })

  it('applies to use(plugin) and to plugins nested inside another plugin', async () => {
    const { bot } = await createTestBot()
    expect(() => bot.use(plugin('x', { requires: ['y'] }))).toThrow(/requires/)
    expect(() => bot.plug(plugin('parent', {
      install(ctx) {
        ctx.bot.plug(plugin('y'))
        ctx.bot.plug(plugin('x', { requires: ['y'] }))
      },
    }))).not.toThrow()
    await bot.stop()
  })

  it('ignores an empty requires list', async () => {
    const { bot } = await createTestBot()
    expect(() => bot.plug(plugin('solo', { requires: [] }))).not.toThrow()
    await bot.stop()
  })
})

describe('plugins: flows registered through ctx.bot are removed on unplug', () => {
  it('registerFlow() inside install() is unregistered by the unsubscriber', async () => {
    const { bot, chat } = await createTestBot()
    const unplug = bot.plug(plugin('surveys', {
      install(ctx) { ctx.bot.registerFlow(flow('encuesta').say('pregunta 1')) },
    }))
    expect(bot.hasFlow('encuesta')).toBe(true)
    await chat.send('encuesta')
    await chat.expectReply('pregunta 1')

    unplug()
    expect(bot.hasFlow('encuesta')).toBe(false)
    expect(bot.listFlows().map((f) => f.id)).not.toContain('encuesta')
    const before = chat.replies().length
    await chat.send('encuesta')
    await tick()
    expect(chat.replies()).toHaveLength(before)
    // the id is free again
    expect(() => bot.registerFlow(flow('encuesta').say('v2'))).not.toThrow()
    await bot.stop()
  })

  it('replaceFlow() that creates a flow inside a plugin is removed too; one that swaps a bot flow is not', async () => {
    const { bot } = await createTestBot()
    bot.registerFlow(flow('own').say('bot'))
    const unplug = bot.plug(plugin('p', {
      install(ctx) {
        ctx.bot.replaceFlow('fresh', flow('fresh').say('plugin'))
        ctx.bot.replaceFlow('own', flow('own').say('patched'))
      },
    }))
    unplug()
    expect(bot.hasFlow('fresh')).toBe(false)
    expect(bot.hasFlow('own')).toBe(true)
    await bot.stop()
  })

  it('a flow the plugin already unregistered (and the bot re-registered) is left alone', async () => {
    const { bot } = await createTestBot()
    let api!: { unregisterFlow(id: string): boolean }
    const unplug = bot.plug(plugin('p', {
      install(ctx) {
        ctx.bot.registerFlow(flow('shared').say('plugin'))
        api = ctx.bot
      },
    }))
    api.unregisterFlow('shared')
    bot.registerFlow(flow('shared').say('bot'))
    unplug()
    expect(bot.hasFlow('shared')).toBe(true)
    await bot.stop()
  })
})

describe('plugins: async install()', () => {
  it('routes a rejected async install() to the error event instead of crashing', async () => {
    const { bot } = await createTestBot()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.plug(plugin('slow', { async install() { throw new Error('boom') } }))
    await tick()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
    await bot.stop()
  })
})
