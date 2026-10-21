/**
 * `TelegramProviderConfig.logger` takes any core `LoggerLike` (pino still accepted).
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@botmesh/core'
import { TelegramProvider } from '../src/TelegramProvider.js'

describe('TelegramProvider logger', () => {
  it('accepts a plain LoggerLike and warns on it when ingest() gets invalid JSON', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const provider = new TelegramProvider({ token: 'x', polling: false, webhookSecret: 's', logger })
    expect(provider.ingest('{oops', { 'x-telegram-bot-api-secret-token': 's' })).toBe(400)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/))
  })

  it('console satisfies the config type', () => {
    const logger: LoggerLike = console
    expect(new TelegramProvider({ token: 'x', logger })).toBeInstanceOf(TelegramProvider)
  })
})
