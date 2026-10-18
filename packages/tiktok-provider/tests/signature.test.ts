import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { parseSignatureHeader, verifyTikTokSignature } from '../src/signature.js'

const SECRET = 'app-secret'
const sign = (t: number, body: string, secret = SECRET) =>
  `t=${t},s=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

describe('parseSignatureHeader', () => {
  it('splits the documented t=<ts>,s=<sig> header', () => {
    expect(parseSignatureHeader('t=1633174587,s=18494715036ac4416a1d0a673871a2edbcfc94d94bd88ccd2c5ec9b3425afe66')).toEqual({
      timestamp: 1633174587,
      signatures: ['18494715036ac4416a1d0a673871a2edbcfc94d94bd88ccd2c5ec9b3425afe66'],
    })
  })
  it('tolerates spaces and keeps every s= element', () => {
    expect(parseSignatureHeader(' t=10 , s=aa, s=bb ')).toEqual({ timestamp: 10, signatures: ['aa', 'bb'] })
  })
  it('returns undefined for a malformed header', () => {
    expect(parseSignatureHeader(undefined)).toBeUndefined()
    expect(parseSignatureHeader('s=abc')).toBeUndefined()
    expect(parseSignatureHeader('t=abc,s=abc')).toBeUndefined()
    expect(parseSignatureHeader('t=10')).toBeUndefined()
  })
})

describe('verifyTikTokSignature', () => {
  const body = '{"event":"comment.update"}'
  const now = 1_700_000_000

  it('accepts HMAC-SHA256(secret, `${t}.${rawBody}`) hex within tolerance', () => {
    expect(verifyTikTokSignature(body, sign(now, body), SECRET, { nowSec: now + 10 })).toEqual({ ok: true })
  })
  it('accepts a Buffer body (raw bytes)', () => {
    expect(verifyTikTokSignature(Buffer.from(body), sign(now, body), SECRET, { nowSec: now })).toEqual({ ok: true })
  })
  it('rejects a forged body', () => {
    expect(verifyTikTokSignature('{"event":"x"}', sign(now, body), SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'mismatch' })
  })
  it('rejects the wrong secret', () => {
    expect(verifyTikTokSignature(body, sign(now, body, 'other'), SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'mismatch' })
  })
  it('rejects a stale timestamp (replay) even with a valid signature', () => {
    expect(verifyTikTokSignature(body, sign(now, body), SECRET, { nowSec: now + 301 })).toEqual({ ok: false, reason: 'stale' })
    expect(verifyTikTokSignature(body, sign(now, body), SECRET, { nowSec: now + 60, toleranceSec: 30 })).toEqual({ ok: false, reason: 'stale' })
  })
  it('rejects timestamps too far in the future', () => {
    expect(verifyTikTokSignature(body, sign(now + 1000, body), SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'stale' })
  })
  it('rejects a missing or malformed header', () => {
    expect(verifyTikTokSignature(body, undefined, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'missing' })
    expect(verifyTikTokSignature(body, 'garbage', SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'missing' })
  })
  it('rejects when the timestamp in the header was tampered with', () => {
    const header = sign(now, body).replace(`t=${now}`, `t=${now + 1}`)
    expect(verifyTikTokSignature(body, header, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'mismatch' })
  })
})
