/**
 * `logger` takes any core `LoggerLike` (pino still accepted): a plain object or `console`
 * constructs the provider and receives its log lines.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@botmesh/core'
import { DiscordProvider } from '../src/DiscordProvider.js'

describe('DiscordProvider logger', () => {
  it('accepts a plain LoggerLike and console', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const base = { token: 'TOK', reconnectDelayMs: 0 }
    expect(new DiscordProvider({ ...base, logger: spy })).toBeInstanceOf(DiscordProvider)
    const consoleLike: LoggerLike = console
    expect(new DiscordProvider({ ...base, logger: consoleLike })).toBeInstanceOf(DiscordProvider)
  })
})
