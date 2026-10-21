/**
 * `BaileysProviderConfig.logger` takes any core `LoggerLike`; Baileys' own functions
 * receive a `BaileysLogger` through `toBaileysLogger()`.
 */
import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import type { LoggerLike } from '@botmesh/core'
import { BaileysProvider } from '../src/BaileysProvider.js'
import { isBaileysLogger, toBaileysLogger, type BaileysLogger } from '../src/logger.js'

const spyLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('toBaileysLogger', () => {
  it('passes a pino logger through untouched (identity)', () => {
    const logger = pino({ level: 'silent' })
    expect(isBaileysLogger(logger)).toBe(true)
    expect(toBaileysLogger(logger)).toBe(logger)
  })

  it('wraps a plain { debug, info, warn, error } logger: trace is a no-op, level falls back', () => {
    const logger = spyLogger()
    expect(isBaileysLogger(logger)).toBe(false)
    const wa = toBaileysLogger(logger)
    expect(wa.level).toBe('info')
    expect(() => wa.trace({ noisy: true }, 'trace line')).not.toThrow()
    wa.debug({ a: 1 }, 'd')
    wa.info({ b: 2 }, 'i')
    wa.warn({ c: 3 }, 'w')
    wa.error({ d: 4 })
    expect(logger.debug).toHaveBeenCalledWith({ a: 1 }, 'd')
    expect(logger.info).toHaveBeenCalledWith({ b: 2 }, 'i')
    expect(logger.warn).toHaveBeenCalledWith({ c: 3 }, 'w')
    expect(logger.error).toHaveBeenCalledWith({ d: 4 })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(toBaileysLogger(logger, 'debug').level).toBe('debug')
  })

  it('forwards trace and a string level when the logger has them', () => {
    const trace = vi.fn()
    const logger = { ...spyLogger(), trace, level: 'trace' }
    const wa = toBaileysLogger(logger)
    expect(wa.level).toBe('trace')
    wa.trace({ x: 1 }, 't')
    expect(trace).toHaveBeenCalledWith({ x: 1 }, 't')
  })

  it('child() wraps logger.child() when available, else reuses the same logger', () => {
    const childSpy = spyLogger()
    const child = vi.fn(() => childSpy)
    const withChild: LoggerLike = { ...spyLogger(), child }
    const wa = toBaileysLogger(withChild)
    const kid: BaileysLogger = wa.child({ module: 'x' })
    expect(child).toHaveBeenCalledWith({ module: 'x' })
    kid.warn({ k: 1 }, 'from child')
    expect(childSpy.warn).toHaveBeenCalledWith({ k: 1 }, 'from child')

    const noChild = spyLogger()
    const kid2 = toBaileysLogger(noChild).child({ module: 'y' })
    kid2.info({ k: 2 }, 'same logger')
    expect(noChild.info).toHaveBeenCalledWith({ k: 2 }, 'same logger')
  })

  it('console satisfies the config type and the provider constructs with it', () => {
    const consoleLike: LoggerLike = console
    const provider = new BaileysProvider({ session: 'demo', logger: consoleLike })
    expect(provider).toBeInstanceOf(BaileysProvider)
    const spy = spyLogger()
    // A custom browser tuple triggers the constructor warning on the injected logger.
    new BaileysProvider({ session: 'demo', logger: spy, browser: ['X', 'Y', '1'] })
    expect(spy.warn).toHaveBeenCalledTimes(1)
  })
})
