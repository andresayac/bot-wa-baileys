import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyChallenge, verifySignature } from '../src/webhook.js'

describe('verifyChallenge', () => {
  it('echoes the challenge when mode+token match', () => {
    const out = verifyChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 's3cret', 'hub.challenge': '12345' },
      's3cret',
    )
    expect(out).toBe('12345')
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

  it('accepts a valid signature', () => {
    expect(verifySignature(body, sig, secret)).toBe(true)
  })
  it('rejects a tampered body', () => {
    expect(verifySignature(body + 'x', sig, secret)).toBe(false)
  })
  it('rejects a missing header', () => {
    expect(verifySignature(body, undefined, secret)).toBe(false)
  })
  it('rejects when no appSecret configured', () => {
    expect(verifySignature(body, sig, undefined)).toBe(false)
  })
})
