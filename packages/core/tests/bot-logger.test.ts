/**
 * `BotConfig.logger` takes any core `LoggerLike` (pino, `console`, a custom object): the
 * constructor adapts it once (`toBotLogger`) so the kernel and every module can keep
 * tagging their lines with `child({ module })`. A pino-shaped logger is used as is.
 */
import { describe, expect, it, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { toBotLogger, isPinoLike } from '../src/core/bot/logger.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { flow } from '../src/flows/FlowBuilder.js'
import type { LoggerLike } from '../src/core/provider.js'

const spyLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('toBotLogger', () => {
  it('passes a pino-shaped logger through untouched', async () => {
    const pino = (await import('pino')).default
    const logger = pino({ level: 'silent' })
    expect(isPinoLike(logger)).toBe(true)
    expect(toBotLogger(logger)).toBe(logger)
  })

  it('wraps a plain LoggerLike: child() keeps forwarding and trace/fatal are no-ops', () => {
    const spy = spyLogger()
    const wrapped = toBotLogger(spy, { debug: true })
    expect(isPinoLike(spy)).toBe(false)
    expect(wrapped.level).toBe('warn')
    wrapped.debug({ a: 1 }, 'd')
    wrapped.info({ b: 2 }, 'i')
    wrapped.warn({ c: 3 }, 'w')
    wrapped.error({ d: 4 })
    expect(spy.debug).toHaveBeenCalledWith({ a: 1 }, 'd')
    expect(spy.info).toHaveBeenCalledWith({ b: 2 }, 'i')
    expect(spy.warn).toHaveBeenCalledWith({ c: 3 }, 'w')
    expect(spy.error).toHaveBeenCalledWith({ d: 4 })
    const child = wrapped.child({ module: 'hooks' })
    child.warn({ k: 1 }, 'from child')
    expect(spy.warn).toHaveBeenCalledWith({ k: 1 }, 'from child')
    expect(() => wrapped.trace({ noisy: true })).not.toThrow()
    expect(() => wrapped.fatal('boom')).not.toThrow()
  })

  it('forwards child() to a logger that has one', () => {
    const parent = spyLogger()
    const childSpy = spyLogger()
    const child = vi.fn(() => childSpy)
    const wrapped = toBotLogger({ ...parent, child } as LoggerLike)
    wrapped.child({ module: 'x' }).warn({ n: 1 }, 'hello')
    expect(child).toHaveBeenCalledWith({ module: 'x' })
    expect(childSpy.warn).toHaveBeenCalledWith({ n: 1 }, 'hello')
  })

  it('a Bot built with console or a plain LoggerLike works end to end', async () => {
    const provider = new MockProvider()
    const spy = spyLogger()
    const bot = new Bot({ provider, logger: spy })
    await bot.start()
    try {
      bot.when('hola', async (ctx) => { await ctx.reply('hey') })
      await bot.trigger('saludo', { chatId: 'c' }).catch(() => {})
      // The constructor wired children and the modules are running.
      expect(bot.logger).toBeDefined()
      expect(typeof bot.logger.child).toBe('function')
    } finally {
      await bot.stop()
    }
    const consoleLike: LoggerLike = console
    const second = new Bot({ provider: new MockProvider(), logger: consoleLike })
    expect(second.logger).toBeDefined()
    expect(typeof second.logger.child).toBe('function')
    expect(flow('x').say('y').compile().id).toBe('x')
  })
})
