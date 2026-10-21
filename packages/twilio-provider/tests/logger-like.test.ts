/**
 * `logger` takes any core `LoggerLike` (pino still accepted): a plain object or `console`
 * constructs the provider and receives its log lines.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@botmesh/core'
import { TwilioProvider } from '../src/TwilioProvider.js'

describe('TwilioProvider logger', () => {
  it('accepts a plain LoggerLike and console', () => {
    const spy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const base = { accountSid: 'AC1', authToken: 'tok', whatsappFrom: 'whatsapp:+14155238886', webhookUrl: 'https://bot.example.com/hook' }
    expect(new TwilioProvider({ ...base, logger: spy })).toBeInstanceOf(TwilioProvider)
    const consoleLike: LoggerLike = console
    expect(new TwilioProvider({ ...base, logger: consoleLike })).toBeInstanceOf(TwilioProvider)
  })
})
