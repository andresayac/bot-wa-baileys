/**
 * BaileysProvider.send must reject with a TYPED ProviderError (contract §8),
 * like the other transports — not leak a raw Boom/Baileys internal. mapSendError
 * is the pure classifier used on the send() catch path.
 */
import { describe, it, expect } from 'vitest'
import { Boom } from '@hapi/boom'
import { mapSendError } from '../src/BaileysProvider.js'
import {
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
} from '@bot-wa/core'

describe('mapSendError', () => {
  it('maps 429 to RateLimitedError honoring retry-after', () => {
    const boom = new Boom('slow down', { statusCode: 429 })
    boom.output.headers = { 'retry-after': '5' }
    const e = mapSendError(boom, 'c@s.whatsapp.net')
    expect(e).toBeInstanceOf(RateLimitedError)
    expect((e as RateLimitedError).retryAfterMs).toBe(5000)
  })

  it('maps 429 without retry-after to a default delay', () => {
    const e = mapSendError(new Boom('slow', { statusCode: 429 }), 'c')
    expect(e).toBeInstanceOf(RateLimitedError)
    expect((e as RateLimitedError).retryAfterMs).toBe(1000)
  })

  it('maps 413 / "too large" to PayloadTooLargeError', () => {
    expect(mapSendError(new Boom('x', { statusCode: 413 }), 'c')).toBeInstanceOf(PayloadTooLargeError)
    expect(mapSendError(new Error('media too large'), 'c')).toBeInstanceOf(PayloadTooLargeError)
  })

  it('maps 403/forbidden to RecipientUnreachableError with the chatId', () => {
    const e = mapSendError(new Boom('nope', { statusCode: 403 }), 'victim@s.whatsapp.net')
    expect(e).toBeInstanceOf(RecipientUnreachableError)
    expect((e as RecipientUnreachableError).chatId).toBe('victim@s.whatsapp.net')
    expect(mapSendError(new Error('recipient blocked you'), 'c')).toBeInstanceOf(RecipientUnreachableError)
  })

  it('wraps an unknown error in a generic ProviderError, preserving cause', () => {
    const original = new Error('socket exploded')
    const e = mapSendError(original, 'c')
    expect(e).toBeInstanceOf(ProviderError)
    expect(e.constructor).toBe(ProviderError) // not a subclass
    expect(e.message).toBe('socket exploded')
    expect((e as { cause?: unknown }).cause).toBe(original)
  })

  it('passes an already-typed ProviderError through unchanged', () => {
    const typed = new RateLimitedError(2000)
    expect(mapSendError(typed, 'c')).toBe(typed)
  })
})
