/**
 * `logger` takes any core `LoggerLike` (pino still accepted): a plain object or `console`
 * constructs the provider and receives its log lines.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@bot-wa/core'
import { WPPConnectProvider } from '../src/WPPConnectProvider.js'

describe('WPPConnectProvider logger', () => {
  it('accepts a plain LoggerLike and console', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const base = { session: 'my-bot', token: 'T', webhookToken: 'wh' }
    expect(new WPPConnectProvider({ ...base, logger: spy })).toBeInstanceOf(WPPConnectProvider)
    const consoleLike: LoggerLike = console
    expect(new WPPConnectProvider({ ...base, logger: consoleLike })).toBeInstanceOf(WPPConnectProvider)
  })
})
