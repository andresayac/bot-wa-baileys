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
      debug: false,
      commandPrefix: '/',
      conversationScope: 'participant',
      conversation: { timeout: '30s', timeoutMessage: 'expired' },
      groupMode: 'mentions',
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
