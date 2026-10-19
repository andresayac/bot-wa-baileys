import { describe, it, expect } from 'vitest'
import { ProviderError } from '@bot-wa/core'
import { TwilioProvider } from '../src/TwilioProvider.js'
import { fakeHttp } from './support.js'

const down = () => fakeHttp(() => { throw new TypeError('fetch failed') }).http

describe('TwilioProvider — transport failures are typed', () => {
  const make = () => new TwilioProvider({
    accountSid: 'AC1', authToken: 'tok', whatsappFrom: 'whatsapp:+14155238886', webhookUrl: 'https://bot.example.com/tw', http: down(),
  })

  it('send rejects with a ProviderError when the request never gets a response', async () => {
    const err = await make().send('whatsapp:+573001', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toMatch(/Twilio request failed/)
  })

  it('downloadMedia rejects with a ProviderError too', async () => {
    const err = await make().downloadMedia({ kind: 'image', token: { url: 'https://api.twilio.com/media/1' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
  })
})
