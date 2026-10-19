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

  describe('131051 (unsupported message type)', () => {
    it("defaults to kind 'native' when the request kind is unknown", () => {
      const e = toGraphError({ code: 131051, message: 'Unsupported message type' })
      expect(e).toBeInstanceOf(UnsupportedContentError)
      expect((e as UnsupportedContentError).kind).toBe('native')
      expect(e.message).toContain('131051')
    })
    it('reports the kind of the failing request when the caller knows it', () => {
      const e = toGraphError({ code: 131051 }, { contentKind: 'poll' })
      expect((e as UnsupportedContentError).kind).toBe('poll')
    })
  })

  describe('131062 (BSUID recipients not supported for this message)', () => {
    const err = { code: 131062, message: 'Business-scoped User ID (BSUID) recipients are not supported for this message.' }

    it("maps to UnsupportedContentError with kind 'template' for a template send", () => {
      const e = toGraphError(err, { chatId: 'US.13491208655302741918', contentKind: 'template' })
      expect(e).toBeInstanceOf(UnsupportedContentError)
      expect((e as UnsupportedContentError).kind).toBe('template')
      expect(e.message).toContain('131062')
      expect(e.message).toContain(err.message)
    })
    it("defaults to kind 'template' (only auth templates are refused for BSUIDs)", () => {
      const e = toGraphError(err)
      expect(e).toBeInstanceOf(UnsupportedContentError)
      expect((e as UnsupportedContentError).kind).toBe('template')
    })
    it('keeps the request kind when the failing send was not a template', () => {
      const e = toGraphError(err, { contentKind: 'text' })
      expect(e).toBeInstanceOf(UnsupportedContentError)
      expect((e as UnsupportedContentError).kind).toBe('text')
    })
    it('tells the caller to address the user by phone number instead', () => {
      expect(toGraphError(err).message).toMatch(/phone number/i)
    })
    it('is not mistaken for a window or reachability error', () => {
      const e = toGraphError(err, { chatId: 'US.1' })
      expect(e).not.toBeInstanceOf(OutsideSessionWindowError)
      expect(e).not.toBeInstanceOf(RecipientUnreachableError)
    })
  })

  it('leaves the username-management codes (147001-147005) as a generic ProviderError', () => {
    // Returned by the business-username API, never by a message send: no typed send error fits.
    for (const code of [147001, 147002, 147003, 147004, 147005]) {
      const e = toGraphError({ code, message: 'Username not available' })
      expect(e.constructor).toBe(ProviderError)
      expect(e.message).toContain(String(code))
    }
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
    const parsed = { object: 'page' }
    const parsedSig = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(parsed)).digest('hex')
    const res = checkGraphSignature(parsed, { 'x-hub-signature-256': parsedSig }, secret, { warn: (m) => warnings.push(m) })
    expect(res).toEqual({ ok: false, status: 400 })
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

describe('security audit hardening', () => {
  it('verifyChallenge never accepts an empty configured verify token', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, '')).toBeNull()
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.challenge': '1' }, '')).toBeNull()
  })

  it('verifyChallenge rejects non-string (array) query values', () => {
    const query = { 'hub.mode': 'subscribe', 'hub.verify_token': ['s3cret'], 'hub.challenge': '1' } as unknown as Parameters<typeof verifyChallenge>[0]
    expect(verifyChallenge(query, 's3cret')).toBeNull()
  })

  it('checkGraphSignature finds the signature header regardless of its casing', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}')
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`
    expect(checkGraphSignature(raw, { 'X-Hub-Signature-256': sig }, 'app-secret')).toEqual({ ok: true })
  })

  it('verifySignature accepts an upper-case hex digest and rejects garbage', () => {
    const raw = Buffer.from('{}')
    const hex = createHmac('sha256', 'k').update(raw).digest('hex')
    expect(verifySignature(raw, `sha256=${hex.toUpperCase()}`, 'k')).toBe(true)
    expect(verifySignature(raw, 'sha256=zz', 'k')).toBe(false)
  })
})
