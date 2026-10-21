/** Durable media refs: WPPConnect's `messageId` is journaled and rebuilt on replay. */
import { describe, expect, it } from 'vitest'
import type { MediaRef, SerializedMediaRef } from '@botmesh/core'
import { WPPConnectProvider } from '../src/index.js'

const provider = new WPPConnectProvider({ session: 's', token: 't', webhookToken: 'w' })
const ref = (token: unknown): MediaRef => ({ kind: 'video', token })

describe('WPPConnectProvider media refs', () => {
  it('journals the message id and round-trips it', () => {
    const stored = provider.serializeMediaRef(ref({ messageId: 'true_57300@c.us_ABC' }))
    expect(stored).toEqual({ v: 1, data: { messageId: 'true_57300@c.us_ABC' } })
    expect(provider.rehydrateMediaRef(stored!, { kind: 'video' })).toEqual({ kind: 'video', token: { messageId: 'true_57300@c.us_ABC' } })
  })

  it('declines invalid tokens and validates journaled values', () => {
    expect(provider.serializeMediaRef(ref({}))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: '' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ messageId: 'x'.repeat(600) }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref(null))).toBeUndefined()
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { messageId: 42 } } as unknown as SerializedMediaRef, { kind: 'video' })).toThrow(/Invalid WPPConnect/)
    expect(() => provider.rehydrateMediaRef({ v: 2, data: { messageId: 'x' } } as SerializedMediaRef, { kind: 'video' })).toThrow(/Invalid WPPConnect/)
  })
})
