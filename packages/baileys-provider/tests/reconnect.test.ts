import { describe, it, expect } from 'vitest'
import { DisconnectReason } from '@whiskeysockets/baileys'
import { classifyDisconnect, backoffDelay, MAX_RECONNECT_ATTEMPTS } from '../src/reconnect.js'

describe('classifyDisconnect', () => {
  it('wipes on invalid-session codes', () => {
    expect(classifyDisconnect(DisconnectReason.loggedOut)).toBe('wipe')
    expect(classifyDisconnect(DisconnectReason.badSession)).toBe('wipe')
    expect(classifyDisconnect(DisconnectReason.multideviceMismatch)).toBe('wipe')
  })

  it('stops (no reconnect) on conflict/replaced and forbidden', () => {
    // 440 conflict — another device/instance took the session (the real-world
    // storm we observed: reconnecting just fights forever and risks a ban).
    expect(classifyDisconnect(DisconnectReason.connectionReplaced)).toBe('stop')
    expect(classifyDisconnect(DisconnectReason.forbidden)).toBe('stop')
  })

  it('reconnects immediately on restartRequired (pairing flow)', () => {
    expect(classifyDisconnect(DisconnectReason.restartRequired)).toBe('reconnect-now')
  })

  it('backs off on transient closes and unknown codes', () => {
    expect(classifyDisconnect(DisconnectReason.connectionClosed)).toBe('reconnect-backoff')
    expect(classifyDisconnect(DisconnectReason.connectionLost)).toBe('reconnect-backoff')
    expect(classifyDisconnect(DisconnectReason.timedOut)).toBe('reconnect-backoff')
    expect(classifyDisconnect(DisconnectReason.unavailableService)).toBe('reconnect-backoff')
    expect(classifyDisconnect(undefined)).toBe('reconnect-backoff')
    expect(classifyDisconnect(9999)).toBe('reconnect-backoff')
  })
})

describe('backoffDelay', () => {
  it('grows exponentially from 1s and caps at 30s', () => {
    expect(backoffDelay(0)).toBe(1000)
    expect(backoffDelay(1)).toBe(2000)
    expect(backoffDelay(2)).toBe(4000)
    expect(backoffDelay(5)).toBe(30_000) // 32000 capped
    expect(backoffDelay(20)).toBe(30_000)
  })

  it('treats negative attempts as 0', () => {
    expect(backoffDelay(-3)).toBe(1000)
  })

  it('respects custom base and cap', () => {
    expect(backoffDelay(0, 500, 5000)).toBe(500)
    expect(backoffDelay(10, 500, 5000)).toBe(5000)
  })
})

describe('MAX_RECONNECT_ATTEMPTS', () => {
  it('is a sane positive cap', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0)
    expect(MAX_RECONNECT_ATTEMPTS).toBeLessThanOrEqual(20)
  })
})
