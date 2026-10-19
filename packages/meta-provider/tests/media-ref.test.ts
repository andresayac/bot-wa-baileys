/** Durable media references: the journaled Cloud API media id round-trips and downloads like a live one. */
import { describe, expect, it, vi } from 'vitest'
import { ProviderError, type SerializedMediaRef } from '@bot-wa/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'

const baseCfg = { accessToken: 'TOK', phoneNumberId: 'PNID', verifyToken: 'vt', allowUnsignedWebhooks: true }
const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as SerializedMediaRef

describe('Cloud API durable media references', () => {
  const p = new CloudAPIProvider(baseCfg)

  it('round-trips the media id (and never the access token)', () => {
    const s = p.serializeMediaRef({ kind: 'audio', mimetype: 'audio/ogg', token: '1234567890123456' })!
    expect(s).toEqual({ v: 1, data: '1234567890123456' })
    expect(JSON.stringify(s)).not.toContain('TOK')
    expect(p.rehydrateMediaRef(throughJson(s), { kind: 'audio', mimetype: 'audio/ogg' }))
      .toEqual({ kind: 'audio', mimetype: 'audio/ogg', token: '1234567890123456' })
  })

  it('declines tokens that are not a media id', () => {
    expect(p.serializeMediaRef({ kind: 'image', token: undefined })).toBeUndefined()
    expect(p.serializeMediaRef({ kind: 'image', token: 'https://evil.example/x' })).toBeUndefined()
  })

  it('rejects invalid, tampered or unknown-version references', () => {
    for (const stored of [
      { v: 2, data: '123' }, { v: 1, data: 123 }, { v: 1, data: '../me' }, { v: 1, data: '123?fields=x' },
      { v: 1, data: '1'.repeat(200) }, { v: 1, data: { id: '1' } },
    ] as SerializedMediaRef[]) {
      expect(() => p.rehydrateMediaRef(stored, { kind: 'image' })).toThrow(ProviderError)
    }
  })

  it('a rehydrated ref downloads through the same Graph call as the live one', async () => {
    const live = new CloudAPIProvider(baseCfg)
    const graph = (live as unknown as { graph: { downloadMedia(id: string): Promise<{ buffer: Buffer; mimetype: string }> } }).graph
    const spy = vi.spyOn(graph, 'downloadMedia').mockResolvedValue({ buffer: Buffer.from('OGG'), mimetype: 'audio/ogg' })
    const ref = live.rehydrateMediaRef(throughJson(live.serializeMediaRef({ kind: 'audio', token: '42' })), { kind: 'audio' })
    expect(String(await live.downloadMedia(ref))).toBe('OGG')
    expect(spy).toHaveBeenCalledWith('42')
  })
})
