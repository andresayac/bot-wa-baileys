/**
 * `logger` takes any core `LoggerLike` (pino still accepted): a plain object or `console`
 * constructs the provider and receives its log lines.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@bot-wa/core'
import { TikTokProvider } from '../src/TikTokProvider.js'

describe('TikTokProvider logger', () => {
  it('accepts a plain LoggerLike and console', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const base = { accessToken: 'ACCESS', businessId: 'biz', appSecret: 'S', selfUniqueIdentifier: 'me' }
    expect(new TikTokProvider({ ...base, logger: spy })).toBeInstanceOf(TikTokProvider)
    const consoleLike: LoggerLike = console
    expect(new TikTokProvider({ ...base, logger: consoleLike })).toBeInstanceOf(TikTokProvider)
  })
})
