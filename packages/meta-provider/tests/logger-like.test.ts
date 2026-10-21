/**
 * `CloudAPIProviderConfig.logger` takes any core `LoggerLike` (pino still accepted).
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoggerLike } from '@bot-wa/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'

describe('CloudAPIProvider logger', () => {
  it('accepts a plain LoggerLike and logs the unverified-webhook warning on it', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    new CloudAPIProvider({ accessToken: 'a', phoneNumberId: '1', verifyToken: 'v', allowUnsignedWebhooks: true, logger })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/unsigned webhook mode/))
  })

  it('console satisfies the config type', () => {
    const logger: LoggerLike = console
    expect(new CloudAPIProvider({ accessToken: 'a', phoneNumberId: '1', verifyToken: 'v', appSecret: 's', logger })).toBeInstanceOf(CloudAPIProvider)
  })
})
