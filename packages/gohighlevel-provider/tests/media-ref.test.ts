/** Durable media refs: the HighLevel attachment URL is journaled only when it is a safe http(s) URL. */
import { describe, expect, it } from 'vitest'
import type { MediaRef, SerializedMediaRef } from '@botmesh/core'
import { GoHighLevelProvider } from '../src/index.js'

const provider = new GoHighLevelProvider({ accessToken: 'pit', locationId: 'loc' })
const ref = (token: unknown): MediaRef => ({ kind: 'image', token })

describe('GoHighLevelProvider media refs', () => {
  it('journals an allowed URL and round-trips it', () => {
    const stored = provider.serializeMediaRef(ref({ url: 'https://storage.leadconnectorhq.com/a.png' }))
    expect(stored).toEqual({ v: 1, data: { url: 'https://storage.leadconnectorhq.com/a.png' } })
    expect(provider.rehydrateMediaRef(stored!, { kind: 'image' })).toEqual({ kind: 'image', token: { url: 'https://storage.leadconnectorhq.com/a.png' } })
    expect(provider.serializeMediaRef(ref('https://storage.leadconnectorhq.com/b.png'))).toEqual({ v: 1, data: { url: 'https://storage.leadconnectorhq.com/b.png' } })
  })

  it('declines unsafe URLs and rejects them on replay', () => {
    expect(provider.serializeMediaRef(ref({ url: 'data:text/plain,hi' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ url: 'https://u:p@host/a.png' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({}))).toBeUndefined()
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { url: 'file:///x' } } as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid HighLevel/)
    expect(() => provider.rehydrateMediaRef({ v: 2, data: { url: 'https://x/a.png' } } as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid HighLevel/)
  })
})
