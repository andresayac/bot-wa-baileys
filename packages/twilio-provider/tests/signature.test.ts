import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { computeTwilioSignature, parseFormParams, verifyTwilioSignature } from '../src/signature.js'

// Reference vector from twilio-node spec/validation.spec.js.
const AUTH_TOKEN = '12345'
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2'
const PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675309',
  Digits: '1234',
  From: '+14158675309',
  To: '+18005551212',
}
const EXPECTED = 'RSOYDt4T1cUTdK1PDd93/VVr8B8='

describe('X-Twilio-Signature', () => {
  it('matches the reference vector from the Twilio SDKs', () => {
    expect(computeTwilioSignature(AUTH_TOKEN, URL_, PARAMS)).toBe(EXPECTED)
  })

  it('signs the URL followed by params sorted by name (key + value)', () => {
    const manual = createHmac('sha1', 'tok')
      .update('https://x.io/hookA1B2a3')
      .digest('base64')
    expect(computeTwilioSignature('tok', 'https://x.io/hook', { a: '3', B: '2', A: '1' })).toBe(manual)
  })

  it('appends repeated params once per unique value, values sorted', () => {
    const manual = createHmac('sha1', 'tok').update('https://x.io/hMediaUrlaMediaUrlb').digest('base64')
    expect(computeTwilioSignature('tok', 'https://x.io/h', { MediaUrl: ['b', 'a', 'b'] })).toBe(manual)
  })

  it('verifies a valid signature and rejects tampered params, URL, token or missing header', () => {
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: EXPECTED, url: URL_, params: PARAMS })).toBe(true)
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: EXPECTED, url: URL_, params: { ...PARAMS, Digits: '9' } })).toBe(false)
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: EXPECTED, url: `${URL_}&x=1`, params: PARAMS })).toBe(false)
    expect(verifyTwilioSignature({ authToken: 'other', signature: EXPECTED, url: URL_, params: PARAMS })).toBe(false)
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: undefined, url: URL_, params: PARAMS })).toBe(false)
  })

  it('is exact about the URL: query order and encoding are part of what was signed', () => {
    const swapped = 'https://mycompany.com/myapp.php?bar=2&foo=1'
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: EXPECTED, url: swapped, params: PARAMS })).toBe(false)
  })

  it('accepts the URL with or without the default port (as the SDKs do)', () => {
    const signedWithPort = computeTwilioSignature('tok', 'https://x.io:443/h', { A: '1' })
    expect(verifyTwilioSignature({ authToken: 'tok', signature: signedWithPort, url: 'https://x.io/h', params: { A: '1' } })).toBe(true)
    const signedWithout = computeTwilioSignature('tok', 'https://x.io/h', { A: '1' })
    expect(verifyTwilioSignature({ authToken: 'tok', signature: signedWithout, url: 'https://x.io:443/h', params: { A: '1' } })).toBe(true)
    // A non-default port is never stripped.
    expect(verifyTwilioSignature({ authToken: 'tok', signature: signedWithout, url: 'https://x.io:8443/h', params: { A: '1' } })).toBe(false)
  })

  it('verifies JSON webhooks through bodySHA256 (URL-only signature + body hash)', () => {
    const body = '{"MessageSid":"SM1"}'
    const hash = createHash('sha256').update(body).digest('hex')
    const url = `https://x.io/h?bodySHA256=${hash}`
    const sig = computeTwilioSignature('tok', url, {})
    expect(verifyTwilioSignature({ authToken: 'tok', signature: sig, url, rawBody: body })).toBe(true)
    expect(verifyTwilioSignature({ authToken: 'tok', signature: sig, url, rawBody: '{"MessageSid":"SM2"}' })).toBe(false)
    expect(verifyTwilioSignature({ authToken: 'tok', signature: sig, url })).toBe(false)
  })

  it('parses form bodies, keeping repeated keys as arrays and decoding +/%XX', () => {
    expect(parseFormParams('Body=hola+mundo%21&MediaUrl=a&MediaUrl=b')).toEqual({ Body: 'hola mundo!', MediaUrl: ['a', 'b'] })
  })
})
