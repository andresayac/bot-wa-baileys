/** Durable media refs: Gupshup's hosted attachment URL is journaled only when it is a safe http(s) URL. */
import { describe, expect, it } from 'vitest'
import type { MediaRef, SerializedMediaRef } from '@bot-wa/core'
import { GupshupProvider } from '../src/index.js'

const provider = new GupshupProvider({ apiKey: 'k', appName: 'a', source: '1', webhookToken: 't' })
const ref = (token: unknown): MediaRef => ({ kind: 'document', token })

describe('GupshupProvider media refs', () => {
  it('journals an http(s) URL token (string or { url }) and round-trips it', () => {
    for (const token of ['https://cdn.gupshup.io/a.pdf', { url: 'https://cdn.gupshup.io/a.pdf', expiresAt: 1 }]) {
      const stored = provider.serializeMediaRef(ref(token))
      expect(stored).toEqual({ v: 1, data: { url: 'https://cdn.gupshup.io/a.pdf' } })
      expect(provider.rehydrateMediaRef(stored!, { kind: 'document' })).toEqual({ kind: 'document', token: { url: 'https://cdn.gupshup.io/a.pdf' } })
    }
  })

  it('declines unsafe or non-http URLs and rejects them on replay', () => {
    expect(provider.serializeMediaRef(ref('ftp://x/a.pdf'))).toBeUndefined()
    expect(provider.serializeMediaRef(ref('javascript:alert(1)'))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ url: 'https://user:pass@host/a.pdf' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ url: `https://host/${'a'.repeat(5000)}` }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({}))).toBeUndefined()
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { url: 'file:///etc/passwd' } } as SerializedMediaRef, { kind: 'document' })).toThrow(/Invalid Gupshup/)
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { url: 'http://' } } as SerializedMediaRef, { kind: 'document' })).toThrow(/Invalid Gupshup/)
  })
})
