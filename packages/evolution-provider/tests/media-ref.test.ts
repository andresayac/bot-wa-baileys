/** Durable media refs: the Evolution message key is journaled (never the base64) and rebuilt on replay. */
import { describe, expect, it } from 'vitest'
import type { MediaRef, SerializedMediaRef } from '@botmesh/core'
import { EvolutionProvider } from '../src/index.js'

const provider = new EvolutionProvider({ baseUrl: 'http://evolution.local', apiKey: 'k', instance: 'i', webhookSecret: 's' })
const ref = (token: unknown): MediaRef => ({ kind: 'image', token })

describe('EvolutionProvider.serializeMediaRef', () => {
  it('journals the message key and drops the inline base64', () => {
    const stored = provider.serializeMediaRef(ref({ key: { remoteJid: '57300@s.whatsapp.net', id: 'ABC', fromMe: false, participant: 'p' }, base64: 'aGVsbG8=' }))
    expect(stored).toEqual({ v: 1, data: { remoteJid: '57300@s.whatsapp.net', id: 'ABC', fromMe: false, participant: 'p' } })
    expect(JSON.stringify(stored)).not.toContain('aGVsbG8')
  })

  it('declines tokens it cannot rebuild safely', () => {
    expect(provider.serializeMediaRef(ref({ base64: 'x' }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ key: { remoteJid: '', id: 'x' } }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ key: { remoteJid: 'r', id: '' } }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref({ key: { remoteJid: 'r'.repeat(600), id: 'x' } }))).toBeUndefined()
    expect(provider.serializeMediaRef(ref('string'))).toBeUndefined()
  })

  it('round-trips and validates a journaled value', () => {
    const stored = provider.serializeMediaRef(ref({ key: { remoteJid: 'r@s.whatsapp.net', id: 'M1', fromMe: true } }))!
    const rebuilt = provider.rehydrateMediaRef(stored, { kind: 'image' })
    expect(rebuilt).toEqual({ kind: 'image', token: { key: { remoteJid: 'r@s.whatsapp.net', id: 'M1', fromMe: true } } })
    expect(() => provider.rehydrateMediaRef({ v: 2, data: { remoteJid: 'r', id: 'x' } } as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid Evolution/)
    expect(() => provider.rehydrateMediaRef({ v: 1, data: { remoteJid: 'r' } } as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid Evolution/)
    expect(() => provider.rehydrateMediaRef({ v: 1, data: 'x' } as unknown as SerializedMediaRef, { kind: 'image' })).toThrow(/Invalid Evolution/)
  })
})
