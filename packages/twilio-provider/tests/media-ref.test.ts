/** Durable media references: the journaled Twilio media URL round-trips, only for Twilio hosts. */
import { describe, expect, it } from 'vitest'
import { ProviderError, type SerializedMediaRef } from '@bot-wa/core'
import { TwilioProvider } from '../src/TwilioProvider.js'
import { fakeHttp } from './support.js'
import { WA_IMAGE } from './fixtures.js'

const SID = 'AC00000000000000000000000000000000'
const TOKEN = 'auth-token-secret'
const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as SerializedMediaRef

function make(extra: Record<string, unknown> = {}) {
  const { calls, http } = fakeHttp(() => ({ bytes: Buffer.from('JPEGDATA') }))
  const provider = new TwilioProvider({ accountSid: SID, authToken: TOKEN, webhookUrl: 'https://bot.example.com/hook', http, ...extra })
  return { provider, calls }
}

describe('Twilio durable media references', () => {
  it('round-trips the media URL and never stores credentials', () => {
    const { provider } = make()
    const s = provider.serializeMediaRef({ kind: 'image', mimetype: 'image/jpeg', token: { url: WA_IMAGE.MediaUrl0 } })!
    expect(s).toEqual({ v: 1, data: { url: WA_IMAGE.MediaUrl0 } })
    expect(JSON.stringify(s)).not.toContain(TOKEN)
    expect(provider.rehydrateMediaRef(throughJson(s), { kind: 'image', mimetype: 'image/jpeg' }))
      .toEqual({ kind: 'image', mimetype: 'image/jpeg', token: { url: WA_IMAGE.MediaUrl0 } })
  })

  it('accepts a custom apiBaseUrl origin', () => {
    const { provider } = make({ apiBaseUrl: 'https://twilio-proxy.example.com' })
    const url = 'https://twilio-proxy.example.com/2010-04-01/Media/ME1'
    expect(provider.rehydrateMediaRef({ v: 1, data: { url } }, { kind: 'image' }).token).toEqual({ url })
  })

  it('rejects foreign, plain-http, metadata and malformed URLs and unknown versions', () => {
    const { provider } = make()
    for (const stored of [
      { v: 1, data: { url: 'http://api.twilio.com/2010-04-01/Media/ME1' } },
      { v: 1, data: { url: 'https://evil.example.com/a.jpg' } },
      { v: 1, data: { url: 'https://twilio.com.evil.example/a.jpg' } },
      { v: 1, data: { url: 'https://169.254.169.254/latest/meta-data' } },
      { v: 1, data: { url: 'https://user:pass@api.twilio.com/x' } },
      { v: 1, data: { url: 'not a url' } },
      { v: 1, data: 'https://api.twilio.com/x' },
      { v: 2, data: { url: WA_IMAGE.MediaUrl0 } },
    ] as SerializedMediaRef[]) {
      expect(() => provider.rehydrateMediaRef(stored, { kind: 'image' }), JSON.stringify(stored)).toThrow(ProviderError)
    }
    expect(provider.serializeMediaRef({ kind: 'image', token: { url: 'https://evil.example.com/a.jpg' } })).toBeUndefined()
  })

  it('a rehydrated ref downloads with Basic auth on the API origin, like the live one', async () => {
    const { provider, calls } = make()
    const ref = provider.rehydrateMediaRef(throughJson(provider.serializeMediaRef({ kind: 'image', token: { url: WA_IMAGE.MediaUrl0 } })), { kind: 'image' })
    expect(String(await provider.downloadMedia(ref))).toBe('JPEGDATA')
    expect(calls[0]!.url).toBe(WA_IMAGE.MediaUrl0)
    expect(calls[0]!.headers.get('authorization')).toMatch(/^Basic /)
  })
})
