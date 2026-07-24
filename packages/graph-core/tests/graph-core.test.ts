import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  verifyChallenge,
  verifySignature,
  toGraphError,
  checkGraphSignature,
  parseGraphBody,
} from '../src/index.js'
import {
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  OutsideSessionWindowError,
  UnsupportedContentError,
} from '@bot-wa/core'

describe('verifyChallenge', () => {
  it('echoes the challenge when mode+token match', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 's3cret', 'hub.challenge': '12345' }, 's3cret')).toBe('12345')
  })
  it('returns null on token mismatch', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }, 's3cret')).toBeNull()
  })
  it('returns null when not a subscribe', () => {
    expect(verifyChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 's3cret', 'hub.challenge': '1' }, 's3cret')).toBeNull()
  })
})

describe('verifySignature', () => {
  const secret = 'app-secret'
  const body = '{"object":"whatsapp_business_account"}'
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  it('accepts a valid signature', () => { expect(verifySignature(body, sig, secret)).toBe(true) })
  it('rejects a tampered body', () => { expect(verifySignature(body + 'x', sig, secret)).toBe(false) })
  it('rejects a missing header', () => { expect(verifySignature(body, undefined, secret)).toBe(false) })
  it('rejects when no appSecret configured', () => { expect(verifySignature(body, sig, undefined)).toBe(false) })
})

describe('toGraphError', () => {
  it('maps the WhatsApp business codes', () => {
    expect(toGraphError({ code: 131047 }, { chatId: 'c' })).toBeInstanceOf(OutsideSessionWindowError)
    expect(toGraphError({ code: 131026 }, { chatId: 'c' })).toBeInstanceOf(RecipientUnreachableError)
    expect(toGraphError({ code: 131051 })).toBeInstanceOf(UnsupportedContentError)
  })
  it('maps every rate-limit code (superset available to all transports)', () => {
    for (const code of [4, 613, 80007, 36003]) {
      const e = toGraphError({ code, message: 'slow' }, { retryAfterMs: 5000 })
      expect(e).toBeInstanceOf(RateLimitedError)
      expect((e as RateLimitedError).retryAfterMs).toBe(5000)
    }
  })
  it('rate-limit defaults to 60s without a Retry-After', () => {
    expect((toGraphError({ code: 4 }) as RateLimitedError).retryAfterMs).toBe(60_000)
  })
  it('falls back to a generic ProviderError', () => {
    const e = toGraphError({ code: 999, message: 'weird' })
    expect(e.constructor).toBe(ProviderError)
    expect(e.message).toContain('999')
  })
})

describe('checkGraphSignature', () => {
  const secret = 'app-secret'
  const body = '{"object":"page"}'
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  it('passes through when no appSecret configured', () => {
    expect(checkGraphSignature(body, {}, undefined)).toEqual({ ok: true })
  })
  it('accepts a correctly-signed raw body', () => {
    expect(checkGraphSignature(body, { 'x-hub-signature-256': sig }, secret)).toEqual({ ok: true })
  })
  it('rejects a missing/invalid signature with 403', () => {
    expect(checkGraphSignature(body, {}, secret)).toEqual({ ok: false, status: 403 })
    expect(checkGraphSignature(body, { 'x-hub-signature-256': 'sha256=bad' }, secret)).toEqual({ ok: false, status: 403 })
  })
  it('warns when a non-raw body is passed with appSecret set', () => {
    const warnings: string[] = []
    const res = checkGraphSignature({ object: 'page' }, {}, secret, { warn: (m) => warnings.push(m) })
    expect(res.ok).toBe(false)
    expect(warnings.some((w) => w.includes('non-raw body'))).toBe(true)
  })
})

describe('parseGraphBody', () => {
  it('parses string, Buffer and object bodies', () => {
    expect(parseGraphBody<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
    expect(parseGraphBody<{ a: number }>(Buffer.from('{"a":2}'))).toEqual({ a: 2 })
    expect(parseGraphBody<{ a: number }>({ a: 3 })).toEqual({ a: 3 })
  })
})
