import { describe, it, expect } from 'vitest'
import {
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type InboundEvent,
} from '@bot-wa/core'
import pino from 'pino'
import { EvolutionProvider } from '../src/EvolutionProvider.js'
import type { EvolutionProviderConfig } from '../src/types.js'
import { signHs256Jwt } from '../src/webhookAuth.js'
import { fakeFetch, fixture, resolver, type Responder } from './support/fake.js'

const PN = '573001112233@s.whatsapp.net'
const BASE = 'http://localhost:8080'

function make(responder: Responder = () => ({ body: fixture('send-text-response') }), extra: Partial<EvolutionProviderConfig> = {}) {
  const { fetch, calls } = fakeFetch(responder)
  const provider = new EvolutionProvider({
    baseUrl: BASE,
    apiKey: 'API-KEY',
    instance: 'my-instance',
    webhookSecret: 'hook-secret',
    http: { fetch, resolver },
    logger: pino({ level: 'silent' }),
    ...extra,
  })
  return { provider, calls }
}

describe('EvolutionProvider — config', () => {
  it('refuses to start without webhook authentication unless explicitly allowed', () => {
    expect(() => new EvolutionProvider({ baseUrl: BASE, apiKey: 'k', instance: 'i' })).toThrow(/webhookSecret/)
    expect(() => new EvolutionProvider({ baseUrl: BASE, apiKey: 'k', instance: 'i', allowUnsignedWebhooks: true })).not.toThrow()
  })

  it('declares WhatsApp-Web capabilities', () => {
    const { provider } = make()
    expect(provider.id).toBe('evolution')
    expect(provider.capabilities).toMatchObject({ buttons: false, lists: false, polls: true, reactions: true, edit: true, pushIngress: true, templates: false })
  })
})

describe('EvolutionProvider.send', () => {
  it('POSTs text to /message/sendText/{instance} with the apikey header', async () => {
    const { provider, calls } = make()
    const res = await provider.send(PN, { kind: 'text', text: 'hola!' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/message/sendText/my-instance`, body: { number: PN, text: 'hola!' } })
    expect(calls[0].headers.apikey).toBe('API-KEY')
    expect(res.ref).toEqual({ id: 'BAE5SENT0000000001', chatId: PN, native: { remoteJid: PN, fromMe: true, id: 'BAE5SENT0000000001' } })
  })

  it('adds quoted, mentions and platformData', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'text', text: 'ok' }, {
      quoted: { id: 'Q1', chatId: PN, native: { remoteJid: '184523390222111@lid', fromMe: false, id: 'Q1' } },
      mentions: ['573004445566@s.whatsapp.net'],
      platformData: { delay: 500 },
    })
    expect(calls[0].body).toMatchObject({
      quoted: { key: { remoteJid: '184523390222111@lid', fromMe: false, id: 'Q1' } },
      mentioned: ['573004445566@s.whatsapp.net'],
      delay: 500,
    })
  })

  it('sends media by URL and inline base64 for buffers', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'image', media: 'https://cdn.example.com/a.png', caption: 'mira' })
    expect(calls[0]).toMatchObject({ url: `${BASE}/message/sendMedia/my-instance`, body: { number: PN, mediatype: 'image', media: 'https://cdn.example.com/a.png', caption: 'mira' } })
    await provider.send(PN, { kind: 'document', media: Buffer.from('%PDF'), filename: 'f.pdf' })
    expect(calls[1].body).toMatchObject({ mediatype: 'document', media: Buffer.from('%PDF').toString('base64'), mimetype: 'application/pdf', fileName: 'f.pdf' })
    await provider.send(PN, { kind: 'voice', media: Buffer.from('OggS') })
    expect(calls[2]).toMatchObject({ url: `${BASE}/message/sendWhatsAppAudio/my-instance`, body: { audio: Buffer.from('OggS').toString('base64') } })
  })

  it('maps poll, location, contact, reaction and degrades buttons to numbered text', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'poll', question: '¿Color?', options: ['Rojo', 'Azul'] })
    await provider.send(PN, { kind: 'location', lat: 4.6, lng: -74.08, name: 'Bogotá' })
    await provider.send(PN, { kind: 'contact', phone: '+57 300 111 2233', displayName: 'Ana' })
    await provider.send(PN, { kind: 'reaction', emoji: '👍', target: { id: 'M1', chatId: PN, native: { remoteJid: PN, fromMe: false, id: 'M1' } } })
    await provider.send(PN, { kind: 'buttons', text: 'Elige', buttons: [{ id: 'a', title: 'Uno' }, { id: 'b', title: 'Dos' }] })
    expect(calls.map((c) => c.url.split('/')[4])).toEqual(['sendPoll', 'sendLocation', 'sendContact', 'sendReaction', 'sendText'])
    expect(calls[0].body).toMatchObject({ name: '¿Color?', selectableCount: 1, values: ['Rojo', 'Azul'] })
    expect(calls[1].body).toMatchObject({ latitude: 4.6, longitude: -74.08, name: 'Bogotá' })
    expect(calls[2].body.contact[0]).toMatchObject({ fullName: 'Ana', wuid: '573001112233' })
    expect(calls[3].body).toEqual({ key: { remoteJid: PN, fromMe: false, id: 'M1' }, reaction: '👍' })
    expect(calls[4].body.text).toBe('Elige\n1) Uno\n2) Dos')
  })

  it('posts native payloads and rejects templates', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'native', provider: 'evolution', payload: { endpoint: 'sendButtons', body: { title: 'T', buttons: [] } } })
    expect(calls[0]).toMatchObject({ url: `${BASE}/message/sendButtons/my-instance`, body: { number: PN, title: 'T' } })
    await expect(provider.send(PN, { kind: 'template', name: 'x', language: 'es' })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(provider.send(PN, { kind: 'native', provider: 'evolution', payload: { endpoint: '../instance/delete', body: {} } })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('maps HTTP errors to typed provider errors', async () => {
    const cases: Array<[Responder, unknown]> = [
      [() => ({ status: 400, body: fixture('error-not-exists') }), RecipientUnreachableError],
      [() => ({ status: 429, body: {}, headers: { 'retry-after': '3' } }), RateLimitedError],
      [() => ({ status: 413, body: 'too big' }), PayloadTooLargeError],
      [() => ({ status: 401, body: { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } } }), ProviderError],
    ]
    for (const [responder, type] of cases) {
      const { provider } = make(responder)
      const err = await provider.send(PN, { kind: 'text', text: 'x' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(type as typeof ProviderError)
      if (err instanceof RateLimitedError) expect(err.retryAfterMs).toBe(3000)
      if (err instanceof RecipientUnreachableError) expect(err.chatId).toBe(PN)
    }
  })

  it('refuses to follow redirects and wraps network failures as ProviderError', async () => {
    const { provider } = make(() => ({ status: 302, headers: { location: 'http://169.254.169.254/' } }))
    await expect(provider.send(PN, { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(ProviderError)
    const strict = make(undefined, { http: { allowPrivateHosts: false, fetch: fakeFetch(() => ({})).fetch, resolver } })
    await expect(strict.provider.send(PN, { kind: 'text', text: 'x' })).rejects.toThrow(/gateway request failed/)
  })
})

describe('EvolutionProvider — actions', () => {
  it('downloads media inline (webhookBase64) or via getBase64FromMediaMessage', async () => {
    const { provider, calls } = make(() => ({ body: { mediaType: 'imageMessage', mimetype: 'image/jpeg', base64: Buffer.from('JPEG').toString('base64') } }))
    const inline = await provider.downloadMedia({ kind: 'image', token: { key: { id: 'X' }, base64: Buffer.from('INLINE').toString('base64') } })
    expect(inline.toString()).toBe('INLINE')
    expect(calls).toHaveLength(0)
    const fetched = await provider.downloadMedia({ kind: 'image', token: { key: { remoteJid: PN, id: 'M1', fromMe: false } } })
    expect(fetched.toString()).toBe('JPEG')
    expect(calls[0]).toMatchObject({ url: `${BASE}/chat/getBase64FromMediaMessage/my-instance`, body: { message: { key: { id: 'M1' } }, convertToMp4: false } })
    await expect(provider.downloadMedia({ kind: 'image', token: 'nope' })).rejects.toBeInstanceOf(ProviderError)
  })

  it('markRead, typing, deleteMessage and editMessage hit the chat controller', async () => {
    const { provider, calls } = make(() => ({ body: {} }))
    const ref = { id: 'M1', chatId: PN, native: { remoteJid: PN, fromMe: true, id: 'M1' } }
    await provider.markRead([ref])
    await provider.typing(PN)
    await provider.deleteMessage(ref)
    await provider.editMessage(ref, { kind: 'text', text: 'editado' })
    expect(calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual([
      'POST /chat/markMessageAsRead/my-instance',
      'POST /chat/sendPresence/my-instance',
      'DELETE /chat/deleteMessageForEveryone/my-instance',
      'POST /chat/updateMessage/my-instance',
    ])
    expect(calls[0].body).toEqual({ readMessages: [{ remoteJid: PN, fromMe: true, id: 'M1' }] })
    expect(calls[1].body).toMatchObject({ number: PN, presence: 'composing' })
    expect(calls[2].body).toEqual({ id: 'M1', remoteJid: PN, fromMe: true })
    expect(calls[3].body).toEqual({ number: PN, key: { remoteJid: PN, fromMe: true, id: 'M1' }, text: 'editado' })
    await expect(provider.editMessage(ref, { kind: 'image', media: 'https://x/y.png' })).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})

describe('EvolutionProvider.start', () => {
  it('emits ready when the instance is open and learns selfId', async () => {
    const { provider } = make((c) => c.url.includes('connectionState')
      ? { body: { instance: { instanceName: 'my-instance', state: 'open' } } }
      : { body: [{ name: 'my-instance', ownerJid: '573009998877@s.whatsapp.net', connectionStatus: 'open' }] })
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await provider.start()
    expect(events.map((e) => (e.kind === 'connection' ? e.update.state : e.kind))).toEqual(['connecting', 'ready'])
    expect(provider.selfId).toBe('573009998877@s.whatsapp.net')
  })

  it('surfaces the QR code when the instance is not paired', async () => {
    const { provider } = make((c) => c.url.includes('connectionState')
      ? { body: { instance: { state: 'close' } } }
      : c.url.includes('/instance/connect/') ? { body: { pairingCode: null, code: '2@QR', count: 1 } } : { body: [] })
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await provider.start()
    expect(events[1]).toEqual({ kind: 'connection', update: { state: 'authenticating', authPayload: '2@QR' } })
  })

  it('rejects and emits closed/sessionInvalid on a bad apikey', async () => {
    const { provider } = make(() => ({ status: 401, body: { error: 'Unauthorized' } }))
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await expect(provider.start()).rejects.toBeInstanceOf(ProviderError)
    expect(events.at(-1)).toMatchObject({ kind: 'connection', update: { state: 'closed', reason: 'sessionInvalid' } })
  })
})

describe('EvolutionProvider.ingest — webhook authentication', () => {
  const body = () => JSON.stringify(fixture('messages-upsert-text-dm'))

  it('accepts the shared secret header (or Bearer) and rejects anything else with 401', () => {
    const { provider } = make()
    const got: InboundEvent[] = []
    provider.onEvent((e) => { got.push(e) })
    expect(provider.ingest(body(), { 'X-Webhook-Secret': 'hook-secret' })).toBe(200)
    expect(provider.ingest(body(), { authorization: 'Bearer hook-secret' })).toBe(200)
    expect(provider.ingest(body(), { 'x-webhook-secret': 'wrong' })).toBe(401)
    expect(provider.ingest(body(), {})).toBe(401)
    expect(provider.ingest(body())).toBe(401)
    expect(got).toHaveLength(2)
  })

  it('verifies Evolution jwt_key tokens (signature, expiry, claims)', () => {
    const { provider } = make(undefined, { webhookSecret: undefined, webhookJwtKey: 'jwt-key' })
    const now = Math.floor(Date.now() / 1000)
    const good = signHs256Jwt({ iat: now, exp: now + 600, app: 'evolution', action: 'webhook' }, 'jwt-key')
    expect(provider.ingest(body(), { authorization: `Bearer ${good}` })).toBe(200)
    const expired = signHs256Jwt({ iat: now - 1200, exp: now - 600, app: 'evolution', action: 'webhook' }, 'jwt-key')
    expect(provider.ingest(body(), { authorization: `Bearer ${expired}` })).toBe(401)
    const forged = signHs256Jwt({ iat: now, exp: now + 600, app: 'evolution', action: 'webhook' }, 'other-key')
    expect(provider.ingest(body(), { authorization: `Bearer ${forged}` })).toBe(401)
    const wrongClaim = signHs256Jwt({ iat: now, exp: now + 600, app: 'other', action: 'webhook' }, 'jwt-key')
    expect(provider.ingest(body(), { authorization: `Bearer ${wrongClaim}` })).toBe(401)
  })

  it('answers 400 for garbage and 200 (ignored) for another instance', () => {
    const { provider } = make()
    const got: InboundEvent[] = []
    provider.onEvent((e) => { got.push(e) })
    const H = { 'x-webhook-secret': 'hook-secret' }
    expect(provider.ingest('{not json', H)).toBe(400)
    expect(provider.ingest({ nope: true }, H)).toBe(400)
    const other = fixture('messages-upsert-text-dm')
    other.instance = 'someone-else'
    expect(provider.ingest(other, H)).toBe(200)
    expect(provider.ingest(Buffer.from(body()), H)).toBe(200)
    expect(got).toHaveLength(1)
  })

  it('learns selfId from connection.update open', () => {
    const { provider } = make()
    provider.ingest(fixture('connection-update-open'), { 'x-webhook-secret': 'hook-secret' })
    expect(provider.selfId).toBe('573009998877@s.whatsapp.net')
  })

  it('a throwing listener does not break ingest', () => {
    const { provider } = make()
    provider.onEvent(() => { throw new Error('boom') })
    expect(provider.ingest(body(), { 'x-webhook-secret': 'hook-secret' })).toBe(200)
  })
})
