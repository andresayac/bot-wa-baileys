import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyChallenge, verifySignature } from '../src/webhook.js'

describe('verifyChallenge', () => {
  it('echoes the challenge when mode + token match', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'CH-123' }, 'vt')).toBe('CH-123')
  })
  it('returns null on token mismatch', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'CH' }, 'vt')).toBeNull()
  })
  it('returns null when mode is not subscribe', () => {
    expect(verifyChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'CH' }, 'vt')).toBeNull()
  })
  it('returns null when the challenge is missing', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt' }, 'vt')).toBeNull()
  })
})

describe('verifySignature', () => {
  const body = '{"object":"page"}'
  const good = 'sha256=' + createHmac('sha256', 'shh').update(body).digest('hex')

  it('accepts a correct X-Hub-Signature-256', () => {
    expect(verifySignature(body, good, 'shh')).toBe(true)
  })
  it('rejects a wrong signature', () => {
    expect(verifySignature(body, 'sha256=deadbeef', 'shh')).toBe(false)
  })
  it('rejects when the header is missing', () => {
    expect(verifySignature(body, undefined, 'shh')).toBe(false)
  })
  it('rejects when the app secret is unset', () => {
    expect(verifySignature(body, good, undefined)).toBe(false)
  })
  it('works with Buffer bodies too', () => {
    expect(verifySignature(Buffer.from(body), good, 'shh')).toBe(true)
  })
})
