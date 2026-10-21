/**
 * `logger` takes any core `LoggerLike` (pino still accepted): a plain object or `console`
 * constructs the provider and receives its log lines.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@botmesh/core'
import { MessengerProvider } from '../src/MessengerProvider.js'

describe('MessengerProvider logger', () => {
  it('accepts a plain LoggerLike and console', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const base = { accessToken: 'a', verifyToken: 'v', appSecret: 's' }
    expect(new MessengerProvider({ ...base, logger: spy })).toBeInstanceOf(MessengerProvider)
    const consoleLike: LoggerLike = console
    expect(new MessengerProvider({ ...base, logger: consoleLike })).toBeInstanceOf(MessengerProvider)
  })
})
