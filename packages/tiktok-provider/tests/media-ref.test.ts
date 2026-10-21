/** Durable media refs: TikTok media coordinates (or a sticker URL) are journaled and rebuilt. */
import { describe, expect, it } from 'vitest'
import type { MediaRef, SerializedMediaRef } from '@bot-wa/core'
import { TikTokProvider } from '../src/index.js'

const provider = new TikTokProvider({ accessToken: 'ACCESS', businessId: 'biz', appSecret: 'S', selfUniqueIdentifier: 'me' })
const ref = (token: unknown): MediaRef => ({ kind: 'image', token })

describe('TikTokProvider media refs', () => {
  it('journals media coordinates (no credentials) and round-trips them', () => {
    const token = { mediaId: 'm1', messageId: 'msg1', conversationId: 'c1', mediaType: 'IMAGE' as const }
    const stored = provider.serializeMediaRef(ref(token))
    expect(stored).toEqual({ v: 1, data: token })
    expect(provider.rehydrateMediaRef(stored!, { kind: 'image' })).toEqual({ kind: 'image', token })
  })

  it('journals a sticker URL and rejects unsafe ones', () => {
    expect(provider.serializeMediaRef(ref({ url: 'https://cdn.tiktok.com/s.webp' }))).toEqual({ v: 1, data: { url: 'https://cdn.tiktok.com/s.webp' } })
    expect(provider.serializeMediaRef(ref({ url: 'file:///etc/passwd' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({}))).toBeUndefined()
    expect(provider.rehydrateMediaRef({ v: 1, data: { url: 'https://cdn.tiktok.com/s.webp' } } as SerializedMediaRef, { kind: 'sticker' })).toEqual({ kind: 'sticker', token: { url: 'https://cdn.tiktok.com/s.webp' } })
  })

  it('validates journaled coordinates on replay', () => {
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { mediaId: 'm1', messageId: 'msg1', conversationId: 'c1', mediaType: 'AUDIO' } } as unknown as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid TikTok/)
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { mediaId: '', messageId: 'msg1', conversationId: 'c1', mediaType: 'IMAGE' } } as unknown as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid TikTok/)
    expect(() => provider.rehydrateMediaRef({ v: 2, data: { mediaId: 'm1', messageId: 'msg1', conversationId: 'c1', mediaType: 'IMAGE' } } as unknown as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid TikTok/)
  })
})
