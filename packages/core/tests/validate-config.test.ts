/**
 * validateConfig — unit tests for runtime config validation.
 */
import { describe, it, expect } from 'vitest'
import { validateConfig, ConfigValidationError } from '../src/utils/validateConfig.js'

describe('validateConfig', () => {
  it('accepts a valid minimal config', () => {
    const config = validateConfig({ session: 'test' })
    expect(config.session).toBe('test')
  })

  it('accepts a full valid config', () => {
    const config = validateConfig({
      session: 'my-bot',
      sessionsDir: './sessions',
      reconnect: true,
      debug: false,
      commandPrefix: '/',
      conversationScope: 'participant',
      qr: { terminal: true, small: true },
      conversation: { timeout: '30s', timeoutMessage: 'expired' },
      browser: 'macOS',
    })
    expect(config.session).toBe('my-bot')
  })

  it('rejects non-string session', () => {
    expect(() => validateConfig({ session: 123 as any })).toThrow(ConfigValidationError)
    expect(() => validateConfig({ session: 123 as any })).toThrow(/config\.session/)
  })

  it('rejects empty commandPrefix', () => {
    expect(() => validateConfig({ commandPrefix: '' })).toThrow(/commandPrefix/)
  })

  it('rejects invalid conversationScope', () => {
    expect(() => validateConfig({ conversationScope: 'invalid' as any })).toThrow(/conversationScope/)
  })

  it('rejects invalid browser string', () => {
    expect(() => validateConfig({ browser: 'linux' as any })).toThrow(/browser/)
  })

  it('rejects browser tuple with wrong length', () => {
    expect(() => validateConfig({ browser: ['a', 'b'] as any })).toThrow(/browser/)
  })

  it('accepts browser tuple with 3 elements', () => {
    const config = validateConfig({ browser: ['Chrome', '120', 'macOS'] })
    expect(config.browser).toEqual(['Chrome', '120', 'macOS'])
  })

  it('rejects non-function qr.handler', () => {
    expect(() => validateConfig({ qr: { handler: 'not-a-fn' as any } })).toThrow(/qr\.handler/)
  })

  it('rejects non-string/number conversation.timeout', () => {
    expect(() => validateConfig({ conversation: { timeout: true as any } })).toThrow(/conversation\.timeout/)
  })

  it('rejects an invalid groupMode (catches the singular "mention" typo)', () => {
    expect(() => validateConfig({ groupMode: 'mention' as any })).toThrow(/groupMode/)
    expect(() => validateConfig({ groupMode: 'mentions' })).not.toThrow()
  })

  it('rejects a non-object rateLimit', () => {
    expect(() => validateConfig({ rateLimit: 'fast' as any })).toThrow(/rateLimit/)
    expect(() => validateConfig({ rateLimit: { perChat: { max: 5, window: '10s' } } })).not.toThrow()
  })

  it('allows undefined optional fields', () => {
    const config = validateConfig({})
    expect(config).toEqual({})
  })
})
