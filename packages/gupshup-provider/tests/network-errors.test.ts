import { describe, it, expect } from 'vitest'
import { ProviderError } from '@botmesh/core'
import { GupshupProvider } from '../src/GupshupProvider.js'
import { fakeHttp } from './support.js'

const down = () => fakeHttp(() => { throw new TypeError('fetch failed') }).http

describe('GupshupProvider — transport failures are typed', () => {
  const make = () => new GupshupProvider({ apiKey: 'k', appName: 'a', source: '1', webhookToken: 't', http: down() })

  it('send rejects with a ProviderError when the request never gets a response', async () => {
    const err = await make().send('573001', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toMatch(/Gupshup request failed/)
  })

  it('downloadMedia rejects with a ProviderError too', async () => {
    const err = await make().downloadMedia({ kind: 'image', token: { url: 'https://filemanager.gupshup.io/x' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
  })
})
