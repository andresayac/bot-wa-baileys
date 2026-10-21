/**
 * `logger` takes any core `LoggerLike` (pino still accepted): a plain object or `console`
 * constructs the provider and receives its log lines.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@botmesh/core'
import { GupshupProvider } from '../src/GupshupProvider.js'

describe('GupshupProvider logger', () => {
  it('accepts a plain LoggerLike and console', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const base = { apiKey: 'k', appName: 'a', source: '1', webhookToken: 't' }
    expect(new GupshupProvider({ ...base, logger: spy })).toBeInstanceOf(GupshupProvider)
    const consoleLike: LoggerLike = console
    expect(new GupshupProvider({ ...base, logger: consoleLike })).toBeInstanceOf(GupshupProvider)
  })
})
