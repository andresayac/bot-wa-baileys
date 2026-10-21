/** Durable media refs: email attachments are located by Message-ID + index + digest, never by content. */
import { describe, expect, it } from 'vitest'
import type { MediaRef, SerializedMediaRef } from '@bot-wa/core'
import { EmailProvider } from '../src/index.js'

const provider = new EmailProvider({ address: 'bot@acme.test' })
const ref = (token: unknown): MediaRef => ({ kind: 'document', token })

describe('EmailProvider media refs', () => {
  it('journals the locator (no bytes, no credentials) and round-trips it', () => {
    const stored = provider.serializeMediaRef(ref({ messageId: '<m1@acme.test>', index: 2, digest: 'abcdef1234567890', uid: 42, uidValidity: '7' }))
    expect(stored).toEqual({ v: 1, data: { messageId: '<m1@acme.test>', index: 2, digest: 'abcdef1234567890', uid: 42, uidValidity: '7' } })
    expect(provider.rehydrateMediaRef(stored!, { kind: 'document' })).toEqual({
      kind: 'document',
      token: { messageId: '<m1@acme.test>', index: 2, digest: 'abcdef1234567890', uid: 42, uidValidity: '7' },
    })
  })

  it('declines incomplete tokens', () => {
    expect(provider.serializeMediaRef(ref({}))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: '', index: 0, digest: 'abcd1234' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: 'm', index: -1, digest: 'abcd1234' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: 'm', index: 1.5, digest: 'abcd1234' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: 'm', index: 0, digest: 'not-a-digest' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: 'm', index: 0 }))).toBeUndefined()
  })

  it('validates a journaled value on replay', () => {
    expect(() => provider.rehydrateMediaRef({ v: 2, data: { messageId: 'm', index: 0, digest: 'abcd1234' } } as SerializedMediaRef, { kind: 'document' })).toThrow(/Invalid email/)
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { messageId: 'm', index: -1, digest: 'abcd1234' } } as SerializedMediaRef, { kind: 'document' })).toThrow(/Invalid email/)
    expect(() => provider.rehydrateMediaRef({ v: 1, data: 'x' } as unknown as SerializedMediaRef, { kind: 'document' })).toThrow(/Invalid email/)
  })
})
