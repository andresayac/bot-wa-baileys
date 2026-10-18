import { describe, it, expect } from 'vitest'
import pino from 'pino'
import {
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type InboundEvent,
} from '@bot-wa/core'
import { WPPConnectProvider } from '../src/WPPConnectProvider.js'
import type { WPPConnectProviderConfig } from '../src/types.js'
import { fakeFetch, fixture, resolver, type Responder } from './support/fake.js'

const PN = '573001112233@c.us'
const GROUP = '120363041234567890@g.us'
const BASE = 'http://localhost:21465'

function make(responder: Responder = () => ({ status: 201, body: fixture('send-message-response') }), extra: Partial<WPPConnectProviderConfig> = {}) {
  const { fetch, calls } = fakeFetch(responder)
  const provider = new WPPConnectProvider({
    session: 'my-bot',
    token: 'TOKEN',
    webhookToken: 'wh-secret',
    http: { fetch, resolver },
    logger: pino({ level: 'silent' }),
    ...extra,
  })
  return { provider, calls }
}

describe('WPPConnectProvider — config', () => {
  it('requires credentials and webhook authentication unless explicitly allowed', () => {
    expect(() => new WPPConnectProvider({ session: 's', webhookToken: 'x' })).toThrow(/token/)
    expect(() => new WPPConnectProvider({ session: 's', token: 't' })).toThrow(/webhookToken/)
    expect(() => new WPPConnectProvider({ session: 's', token: 't', allowUnsignedWebhooks: true, logger: pino({ level: 'silent' }) })).not.toThrow()
  })

  it('declares WhatsApp-Web capabilities', () => {
    const { provider } = make()
    expect(provider.id).toBe('wppconnect')
    expect(provider.capabilities).toMatchObject({ buttons: false, lists: false, polls: true, reactions: true, edit: true, readReceipts: true, pushIngress: true })
  })
})

describe('WPPConnectProvider.send', () => {
  it('POSTs text to /api/{session}/send-message with the Bearer token', async () => {
    const { provider, calls } = make()
    const res = await provider.send(PN, { kind: 'text', text: 'hola!' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/api/my-bot/send-message`, body: { phone: PN, isGroup: false, message: 'hola!' } })
    expect(calls[0].headers.authorization).toBe('Bearer TOKEN')
    expect(res.ref).toMatchObject({ id: 'true_573001112233@c.us_3EB0SENT0000000001', chatId: PN })
  })

  it('flags groups and LIDs, adds quote and mentions', async () => {
    const { provider, calls } = make()
    await provider.send(GROUP, { kind: 'text', text: 'hi' }, { quoted: { id: 'false_x@g.us_Q1', chatId: GROUP }, mentions: [PN] })
    expect(calls[0].body).toEqual({ phone: GROUP, isGroup: true, message: 'hi', options: { quotedMsg: 'false_x@g.us_Q1', mentionedList: [PN] } })
    await provider.send('184523390222111@lid', { kind: 'text', text: 'hi' })
    expect(calls[1].body).toMatchObject({ phone: '184523390222111@lid', isLid: true })
  })

  it('sends files by URL (path) or inline data URI (base64), voice and sticker', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'image', media: 'https://cdn.example.com/a.png', caption: 'mira' })
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/my-bot/send-file`, body: { phone: PN, path: 'https://cdn.example.com/a.png', caption: 'mira' } })
    await provider.send(PN, { kind: 'document', media: Buffer.from('%PDF'), filename: 'f.pdf' })
    expect(calls[1].body).toMatchObject({ base64: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`, filename: 'f.pdf' })
    await provider.send(PN, { kind: 'voice', media: Buffer.from('OggS') })
    expect(calls[2]).toMatchObject({ url: `${BASE}/api/my-bot/send-voice-base64`, body: { base64Ptt: `data:audio/ogg; codecs=opus;base64,${Buffer.from('OggS').toString('base64')}` } })
    await provider.send(PN, { kind: 'voice', media: { url: 'https://cdn.example.com/v.ogg' } })
    expect(calls[3]).toMatchObject({ url: `${BASE}/api/my-bot/send-voice`, body: { path: 'https://cdn.example.com/v.ogg' } })
    await provider.send(PN, { kind: 'sticker', media: 'https://cdn.example.com/s.webp' })
    expect(calls[4]).toMatchObject({ url: `${BASE}/api/my-bot/send-sticker`, body: { path: 'https://cdn.example.com/s.webp' } })
  })

  it('maps poll, location, contact, reaction and degrades lists to numbered text', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'poll', question: '¿Color?', options: ['Rojo', 'Azul'], multiSelect: true })
    await provider.send(PN, { kind: 'location', lat: 4.6, lng: -74.08, name: 'Bogotá' })
    await provider.send(PN, { kind: 'contact', phone: '+57 300 111 2233', displayName: 'Ana' })
    await provider.send(PN, { kind: 'reaction', emoji: '👍', target: { id: 'false_573001112233@c.us_M1', chatId: PN } })
    await provider.send(PN, { kind: 'list', text: 'Menú', buttonText: 'Ver', sections: [{ rows: [{ id: '1', title: 'Pizza' }] }] })
    expect(calls.map((c) => c.url.split('/').at(-1))).toEqual(['send-poll-message', 'send-location', 'contact-vcard', 'react-message', 'send-message'])
    expect(calls[0].body).toMatchObject({ name: '¿Color?', choices: ['Rojo', 'Azul'], options: { selectableCount: 2 } })
    expect(calls[1].body).toMatchObject({ lat: 4.6, lng: -74.08, title: 'Bogotá' })
    expect(calls[2].body).toMatchObject({ contactsId: '573001112233@c.us', name: 'Ana' })
    expect(calls[3].body).toEqual({ msgId: 'false_573001112233@c.us_M1', reaction: '👍' })
    expect(calls[4].body.message).toBe('Menú\n1) Pizza')
  })

  it('posts native payloads, rejects templates and unsafe endpoints', async () => {
    const { provider, calls } = make()
    await provider.send(PN, { kind: 'native', provider: 'wppconnect', payload: { endpoint: 'send-link-preview', body: { url: 'https://x.y', caption: 'c' } } })
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/my-bot/send-link-preview`, body: { phone: PN, url: 'https://x.y' } })
    await expect(provider.send(PN, { kind: 'template', name: 'x', language: 'es' })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(provider.send(PN, { kind: 'native', provider: 'wppconnect', payload: { endpoint: '../logout-session' } })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('maps HTTP errors to typed provider errors', async () => {
    const cases: Array<[Responder, unknown]> = [
      [() => ({ status: 500, body: fixture('error-send') }), RecipientUnreachableError],
      [() => ({ status: 429, body: {}, headers: { 'retry-after': '2' } }), RateLimitedError],
      [() => ({ status: 413, body: 'too large' }), PayloadTooLargeError],
      [() => ({ status: 500, body: { status: 'Error', message: 'Erro ao enviar a mensagem.' } }), ProviderError],
    ]
    for (const [responder, type] of cases) {
      const { provider } = make(responder)
      const err = await provider.send(PN, { kind: 'text', text: 'x' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(type as typeof ProviderError)
      if (type === ProviderError) expect(err).not.toBeInstanceOf(RecipientUnreachableError)
      if (err instanceof RateLimitedError) expect(err.retryAfterMs).toBe(2000)
    }
  })
})

describe('WPPConnectProvider — token lifecycle', () => {
  it('generates a token from secretKey, and regenerates once on 401 without leaking the key', async () => {
    let issued = 0
    const { provider, calls } = make((c) => {
      if (c.url.endsWith('/generate-token')) return { status: 201, body: { status: 'success', session: 'my-bot', token: `TOK${++issued}` } }
      if (c.headers.authorization === 'Bearer TOK1') return { status: 401, body: { message: 'Token is not present. Check your header and try again' } }
      return { status: 201, body: fixture('send-message-response') }
    }, { token: undefined, secretKey: 'THISISMYSECURETOKEN' })
    await provider.send(PN, { kind: 'text', text: 'x' })
    expect(calls.map((c) => c.url.slice(BASE.length))).toEqual([
      '/api/my-bot/THISISMYSECURETOKEN/generate-token',
      '/api/my-bot/send-message',
      '/api/my-bot/THISISMYSECURETOKEN/generate-token',
      '/api/my-bot/send-message',
    ])
    expect(calls[3].headers.authorization).toBe('Bearer TOK2')
  })

  it('never puts the secretKey in error messages', async () => {
    const { provider } = make(() => ({}), { token: undefined, secretKey: 'TOPSECRET', http: { allowPrivateHosts: false, fetch: fakeFetch(() => ({})).fetch, resolver } })
    const err = (await provider.send(PN, { kind: 'text', text: 'x' }).then(() => undefined, (e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).not.toContain('TOPSECRET')
  })
})

describe('WPPConnectProvider — actions', () => {
  it('downloads media via download-media (data URI prefix tolerated)', async () => {
    const { provider, calls } = make(() => ({ body: { base64: `data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}`, mimetype: 'image/jpeg' } }))
    const buf = await provider.downloadMedia({ kind: 'image', token: { messageId: 'false_x@c.us_M1' } })
    expect(buf.toString()).toBe('JPEG')
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/my-bot/download-media`, body: { messageId: 'false_x@c.us_M1' } })
    await expect(provider.downloadMedia({ kind: 'image', token: 'nope' })).rejects.toBeInstanceOf(ProviderError)
  })

  it('markRead (per chat), typing, recording, delete and edit', async () => {
    const { provider, calls } = make(() => ({ body: { status: 'success', response: {} } }))
    const ref = { id: 'true_573001112233@c.us_M1', chatId: PN }
    await provider.markRead([ref, { ...ref, id: 'other' }])
    await provider.typing(PN)
    await provider.typing(PN, 'recording')
    await provider.typing(PN, 'paused')
    await provider.deleteMessage(ref)
    await provider.editMessage(ref, { kind: 'text', text: 'editado' })
    expect(calls.map((c) => c.url.split('/').at(-1))).toEqual(['send-seen', 'typing', 'recording', 'typing', 'delete-message', 'edit-message'])
    expect(calls[0].body).toEqual({ phone: PN, isGroup: false })
    expect(calls[1].body).toMatchObject({ value: true })
    expect(calls[3].body).toMatchObject({ value: false })
    expect(calls[4].body).toMatchObject({ phone: PN, messageId: 'true_573001112233@c.us_M1' })
    expect(calls[5].body).toEqual({ id: 'true_573001112233@c.us_M1', newText: 'editado' })
    await expect(provider.editMessage(ref, { kind: 'image', media: 'https://x/y.png' })).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})

describe('WPPConnectProvider.start', () => {
  it('starts the session and emits ready when CONNECTED', async () => {
    const { provider, calls } = make((c) => c.url.endsWith('status-session')
      ? { body: { status: 'CONNECTED', qrcode: null, urlcode: null, version: '2.8.0' } }
      : { status: 201, body: { status: 'CONNECTED' } }, { webhookUrl: 'https://bot.example.com/wpp?token=wh-secret' })
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await provider.start()
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/my-bot/start-session`, body: { waitQrCode: false, webhook: 'https://bot.example.com/wpp?token=wh-secret' } })
    expect(events.map((e) => (e.kind === 'connection' ? e.update.state : e.kind))).toEqual(['connecting', 'ready'])
  })

  it('surfaces the QR when the session needs pairing', async () => {
    const { provider } = make((c) => c.url.endsWith('status-session')
      ? { body: { status: 'QRCODE', qrcode: 'data:image/png;base64,AAA', urlcode: '2@QR' } }
      : { body: {} }, { startSession: false })
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await provider.start()
    expect(events[1]).toEqual({ kind: 'connection', update: { state: 'authenticating', authPayload: '2@QR' } })
  })

  it('rejects and emits closed/sessionInvalid on a bad token', async () => {
    const { provider } = make(() => ({ status: 401, body: { message: 'Unauthorized' } }))
    const events: InboundEvent[] = []
    provider.onEvent((e) => { events.push(e) })
    await expect(provider.start()).rejects.toBeInstanceOf(ProviderError)
    expect(events.at(-1)).toMatchObject({ kind: 'connection', update: { state: 'closed', reason: 'sessionInvalid' } })
  })
})

describe('WPPConnectProvider.ingest — webhook authentication', () => {
  const body = () => fixture('onmessage-text-dm')

  it('accepts the token in header, Bearer or the request URL query; rejects otherwise', async () => {
    const { provider } = make()
    const got: InboundEvent[] = []
    provider.onEvent((e) => { got.push(e) })
    expect(await provider.ingest(body(), { 'X-Webhook-Token': 'wh-secret' })).toBe(200)
    expect(await provider.ingest(body(), { authorization: 'Bearer wh-secret' })).toBe(200)
    expect(await provider.ingest(body(), {}, '/webhooks/wpp?token=wh-secret')).toBe(200)
    expect(await provider.ingest(body(), {}, 'https://bot.example.com/webhooks/wpp?token=wrong')).toBe(401)
    expect(await provider.ingest(body(), { 'x-webhook-token': 'nope' })).toBe(401)
    expect(await provider.ingest(body())).toBe(401)
    expect(got).toHaveLength(3)
  })

  it('answers 400 for garbage and ignores other sessions', async () => {
    const { provider } = make()
    const got: InboundEvent[] = []
    provider.onEvent((e) => { got.push(e) })
    const H = { 'x-webhook-token': 'wh-secret' }
    expect(await provider.ingest('{oops', H)).toBe(400)
    expect(await provider.ingest({ hello: 1 }, H)).toBe(400)
    expect(await provider.ingest({ ...body(), session: 'other' }, H)).toBe(200)
    expect(await provider.ingest(Buffer.from(JSON.stringify(body())), H)).toBe(200)
    expect(got).toHaveLength(1)
  })

  it('learns selfId from the recipient of an inbound DM', async () => {
    const { provider } = make()
    expect(provider.selfId).toBeNull()
    await provider.ingest(body(), { 'x-webhook-token': 'wh-secret' })
    expect(provider.selfId).toBe('573009998877@c.us')
  })

  it('a failing pn-lid lookup does not block delivery (LID kept as id)', async () => {
    const { provider } = make(() => ({ status: 500, body: { status: 'error' } }))
    const got: InboundEvent[] = []
    provider.onEvent((e) => { got.push(e) })
    expect(await provider.ingest(fixture('onmessage-lid-dm'), { 'x-webhook-token': 'wh-secret' })).toBe(200)
    expect(got[0]).toMatchObject({ kind: 'message', message: { senderId: '184523390222111@lid' } })
  })
})

describe('WPPConnectProvider.ingest — LID lookups', () => {
  const H = { 'x-webhook-token': 'wh-secret' }
  const pnLid = fixture('pn-lid-response')

  it('emits in arrival order even when an earlier lookup is slower, sharing in-flight lookups', async () => {
    let lookups = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { fetch } = fakeFetch(() => ({ body: pnLid }))
    const slowFetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('pn-lid')) { lookups++; await gate }
      return fetch(input, init)
    }) as typeof globalThis.fetch
    const { provider } = make(undefined, { http: { fetch: slowFetch, resolver } })
    const order: string[] = []
    provider.onEvent((e) => { if (e.kind === 'message') order.push(e.message.body) })
    const first = fixture('onmessage-lid-dm'); first.body = 'first'
    const second = { ...fixture('onmessage-text-dm'), body: 'second' }
    const third = fixture('onmessage-lid-dm'); third.body = 'third'; third.id = 'false_184523390222111@lid_3EB0F00DBABE00000099'
    const p = Promise.all([provider.ingest(first, H), provider.ingest(second, H), provider.ingest(third, H)])
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual([])
    release()
    await p
    expect(order).toEqual(['first', 'second', 'third'])
    expect(lookups).toBe(1)
  })

  it('retries a LID whose lookup failed transiently and then links it to the known PN', async () => {
    let n = 0
    const { provider, calls } = make((call) => {
      if (!call.url.includes('pn-lid')) return { body: {} }
      return n++ === 0 ? { status: 503, body: { status: 'error' } } : { body: pnLid }
    }, { lidRetryMs: 0 })
    const ids: string[] = []
    provider.onEvent((e) => { if (e.kind === 'message') ids.push(e.message.senderId) })
    await provider.ingest(fixture('onmessage-text-dm'), H)
    await provider.ingest(fixture('onmessage-lid-dm'), H)
    await provider.ingest(fixture('onmessage-lid-dm'), H)
    expect(calls.filter((c) => c.url.includes('pn-lid'))).toHaveLength(2)
    expect(ids[0]).toBe('573001112233@c.us')
    expect(ids[2]).toBe('573001112233@c.us')
  })

  it('does not hammer the gateway while a failed LID is cooling down', async () => {
    const { provider, calls } = make(() => ({ status: 503, body: { status: 'error' } }))
    await provider.ingest(fixture('onmessage-lid-dm'), H)
    await provider.ingest(fixture('onmessage-lid-dm'), H)
    expect(calls.filter((c) => c.url.includes('pn-lid'))).toHaveLength(1)
  })
})


describe('WPPConnectProvider.ingest — LID lookup budget', () => {
  it('caps lookups per webhook and runs them in parallel with a short timeout', async () => {
    const { provider, calls } = make(() => ({ status: 404, body: { status: 'error' } }), { maxLidLookups: 3 })
    const msg = fixture('onmessage-lid-dm')
    msg.mentionedJidList = Array.from({ length: 50 }, (_, i) => `${1000 + i}@lid`)
    expect(await provider.ingest(msg, { 'x-webhook-token': 'wh-secret' })).toBe(200)
    const lookups = calls.filter((c) => c.url.includes('pn-lid'))
    expect(lookups).toHaveLength(3)
    expect(lookups[0].url).toContain(encodeURIComponent('184523390222111@lid'))
  })
})
