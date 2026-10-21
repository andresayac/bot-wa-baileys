/** URL media references shared by Messenger and Instagram. */
import { describe, expect, it } from 'vitest'
import { ProviderError, type SerializedMediaRef } from '@botmesh/core'
import { META_MEDIA_HOSTS, rehydrateUrlMediaRef, serializeUrlMediaRef } from '../src/index.js'

const allowed = (url: string) => url.startsWith('https://ok.example/')

describe('URL media references', () => {
  it('serializes only allowed string tokens', () => {
    expect(serializeUrlMediaRef({ kind: 'image', token: 'https://ok.example/a' }, allowed)).toEqual({ v: 1, data: { url: 'https://ok.example/a' } })
    expect(serializeUrlMediaRef({ kind: 'image', token: 'https://no.example/a' }, allowed)).toBeUndefined()
    expect(serializeUrlMediaRef({ kind: 'image', token: { url: 'https://ok.example/a' } }, allowed)).toBeUndefined()
  })

  it('rehydrates a valid value and rejects anything else with ProviderError', () => {
    expect(rehydrateUrlMediaRef({ v: 1, data: { url: 'https://ok.example/a' } }, { kind: 'video', size: 3 }, allowed, 'X'))
      .toEqual({ kind: 'video', size: 3, token: 'https://ok.example/a' })
    for (const stored of [
      { v: 2, data: { url: 'https://ok.example/a' } }, { v: 1, data: 'https://ok.example/a' }, { v: 1, data: null },
      { v: 1, data: ['https://ok.example/a'] }, { v: 1, data: { url: 'https://no.example/a' } }, null,
    ] as unknown as SerializedMediaRef[]) {
      expect(() => rehydrateUrlMediaRef(stored, { kind: 'image' }, allowed, 'X')).toThrow(ProviderError)
    }
  })

  it('lists the Meta attachment CDNs', () => {
    expect(META_MEDIA_HOSTS).toEqual(['fbcdn.net', 'fbsbx.com', 'cdninstagram.com'])
    expect(Object.isFrozen(META_MEDIA_HOSTS)).toBe(true)
  })
})
