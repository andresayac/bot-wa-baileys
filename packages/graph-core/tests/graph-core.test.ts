import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  verifyChallenge,
  verifySignature,
  toGraphError,
  checkGraphSignature,
  parseGraphBody,
  tryParseGraphBody,
  readGraphResponse,
} from '../src/index.js'
import {
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  OutsideSessionWindowError,
  UnsupportedContentError,
} from '@botmesh/core'

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
  it('maps the Messenger Platform window subcodes (Messenger 2018278, Instagram 2534022) with the chat id', () => {
    for (const sub of [2018278, 2534022]) {
      const e = toGraphError({ code: 10, error_subcode: sub, message: 'outside window' }, { chatId: 'PSID' })
      expect(e).toBeInstanceOf(OutsideSessionWindowError)
      expect((e as OutsideSessionWindowError).chatId).toBe('PSID')
      expect(e.message).toContain(`10/${sub}`)
    }
  })
  it('maps the Messenger Platform unreachable-recipient codes (551, subcodes 1545041 / 2018001 / 2534014)', () => {
    expect(toGraphError({ code: 551, message: "This person isn't available" }, { chatId: 'P' })).toBeInstanceOf(RecipientUnreachableError)
    for (const sub of [1545041, 2018001, 2534014]) {
      const e = toGraphError({ code: 100, error_subcode: sub, message: 'No matching user found' }, { chatId: 'P' })
      expect(e).toBeInstanceOf(RecipientUnreachableError)
      expect((e as RecipientUnreachableError).chatId).toBe('P')
    }
  })
  it('a code 10 without a window subcode is not a window error', () => {
    expect(toGraphError({ code: 10, message: 'permission' })).not.toBeInstanceOf(OutsideSessionWindowError)
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

describe('tryParseGraphBody / raw byte bodies', () => {
  it('parses string, Buffer, Uint8Array and object bodies', () => {
    expect(tryParseGraphBody('{"a":1}')).toEqual({ ok: true, body: { a: 1 } })
    expect(tryParseGraphBody(Buffer.from('{"a":2}'))).toEqual({ ok: true, body: { a: 2 } })
    expect(tryParseGraphBody(new Uint8Array(Buffer.from('{"a":3}')))).toEqual({ ok: true, body: { a: 3 } })
    expect(tryParseGraphBody({ a: 4 })).toEqual({ ok: true, body: { a: 4 } })
  })

  it('reports 400 for malformed or non-object bodies instead of throwing', () => {
    for (const bad of ['{nope', '', '[1,2]', '42', 'null', Buffer.from('<html>'), null, 7]) {
      expect(tryParseGraphBody(bad)).toEqual({ ok: false, status: 400 })
    }
  })

  it('checkGraphSignature verifies a Uint8Array raw body', () => {
    const raw = new Uint8Array(Buffer.from('{"object":"page"}'))
    const sig = `sha256=${createHmac('sha256', 'k').update(raw).digest('hex')}`
    expect(checkGraphSignature(raw, { 'x-hub-signature-256': sig }, 'k')).toEqual({ ok: true })
  })
})

describe('toGraphError — throughput and reachability codes', () => {
  it.each([
    [130429, 1_000],
    [131056, 6_000],
    [131048, 60_000],
  ])('maps %i to RateLimitedError with a sensible default delay', (code, delay) => {
    const e = toGraphError({ code, message: 'slow down' })
    expect(e).toBeInstanceOf(RateLimitedError)
    expect((e as RateLimitedError).retryAfterMs).toBe(delay)
    expect((toGraphError({ code }, { retryAfterMs: 9 }) as RateLimitedError).retryAfterMs).toBe(9)
  })

  it('maps 131030 (test number allowed list) and 551 to RecipientUnreachableError', () => {
    const e = toGraphError({ code: 131030, message: 'Recipient not in allowed list' }, { chatId: '573001' })
    expect(e).toBeInstanceOf(RecipientUnreachableError)
    expect(e.message).toMatch(/allowed list/)
    expect(toGraphError({ code: 551, message: 'unavailable' }, { chatId: 'psid' })).toBeInstanceOf(RecipientUnreachableError)
  })

  it('maps Messenger 10/2018278 to OutsideSessionWindowError, other code-10 errors stay generic', () => {
    expect(toGraphError({ code: 10, error_subcode: 2018278, message: 'outside window' }, { chatId: 'psid' })).toBeInstanceOf(OutsideSessionWindowError)
    const other = toGraphError({ code: 10, message: 'permission' })
    expect(other.constructor).toBe(ProviderError)
  })
})

describe('readGraphResponse', () => {
  const res = (status: number, body: unknown, retryAfter: string | null = null) => ({
    ok: status < 400,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => body,
  })

  it('returns the parsed body of a successful response', async () => {
    await expect(readGraphResponse(res(200, { message_id: 'm1' }))).resolves.toEqual({ message_id: 'm1' })
  })

  it('treats an unparsable success body as an empty object', async () => {
    const r = { ...res(200, null), json: async () => { throw new SyntaxError('bad') } }
    await expect(readGraphResponse(r)).resolves.toEqual({})
  })

  it('maps the Messenger Platform window/unreachable codes with the chat id', async () => {
    const win = await readGraphResponse(res(400, { error: { code: 10, error_subcode: 2018278, message: 'w' } }), { chatId: 'PSID' }).catch((e: unknown) => e)
    expect(win).toBeInstanceOf(OutsideSessionWindowError)
    expect((win as OutsideSessionWindowError).chatId).toBe('PSID')
    const gone = await readGraphResponse(res(400, { error: { code: 551, message: 'g' } }), { chatId: 'IG' }).catch((e: unknown) => e)
    expect(gone).toBeInstanceOf(RecipientUnreachableError)
    expect((gone as RecipientUnreachableError).chatId).toBe('IG')
  })

  it('honours Retry-After (seconds) on rate limits', async () => {
    const err = await readGraphResponse(res(429, { error: { code: 4, message: 'slow' } }, '7')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(7000)
  })

  it('an error body on a 200 still throws; a bare HTTP failure becomes a generic ProviderError', async () => {
    await expect(readGraphResponse(res(200, { error: { code: 1, message: 'x' } }))).rejects.toBeInstanceOf(ProviderError)
    await expect(readGraphResponse(res(500, {}))).rejects.toThrow(/HTTP 500/)
  })

  it('passes the content kind through to the unsupported-content codes', async () => {
    const err = await readGraphResponse(res(400, { error: { code: 131051, message: 'u' } }), { contentKind: 'sticker' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsupportedContentError)
    expect((err as UnsupportedContentError).kind).toBe('sticker')
  })
})
