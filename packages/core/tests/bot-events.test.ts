import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'

// These are runtime-behavior tests for the typed BotEvents overloads on Bot.on/once/off/emit
// (Bot.ts). The real payoff is compile-time (editor autocomplete + `pnpm build` staying clean
// with zero `any` in the typed overloads) — this file just proves the overloads didn't change
// runtime behavior: payloads still pass through unchanged for both known and custom events.
describe('Bot typed events (on/once/off/emit)', () => {
  it('on("qr", cb) + emit("qr", payload) passes the string payload through unchanged', async () => {
    const { bot } = await createTestBot()
    const cb = vi.fn()
    bot.on('qr', cb)
    bot.emit('qr', 'raw-qr-string')
    expect(cb).toHaveBeenCalledWith('raw-qr-string')
  })

  it('a void-payload event ("ready") can be emitted and listened to with zero arguments', async () => {
    const { bot } = await createTestBot()
    const cb = vi.fn()
    bot.on('ready', cb)
    bot.emit('ready')
    expect(cb).toHaveBeenCalledWith()
  })

  it('once("qr", cb) fires exactly once', async () => {
    const { bot } = await createTestBot()
    const cb = vi.fn()
    bot.once('qr', cb)
    bot.emit('qr', 'first')
    bot.emit('qr', 'second')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('first')
  })

  it('off("qr", cb) removes the listener', async () => {
    const { bot } = await createTestBot()
    const cb = vi.fn()
    bot.on('qr', cb)
    bot.off('qr', cb)
    bot.emit('qr', 'ignored')
    expect(cb).not.toHaveBeenCalled()
  })

  it('an arbitrary/custom event still compiles and works via the string-fallback overload', async () => {
    const { bot } = await createTestBot()
    const cb = vi.fn()
    bot.on('my:custom-event', cb)
    bot.emit('my:custom-event', { hello: 'world' })
    expect(cb).toHaveBeenCalledWith({ hello: 'world' })
  })
})
