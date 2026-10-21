import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  Bot,
  OutsideSessionWindowError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type IProvider,
  type InboundEvent,
} from '@botmesh/core'
import { GupshupProvider } from '../src/GupshupProvider.js'
import { GupshupApiError } from '../src/errors.js'
import type { GupshupCallback } from '../src/types.js'
import { fakeHttp, type Call, type FakeResponse } from './support.js'
import {
  BUTTON_REPLY, EV_DELIVERED, EV_ENQUEUED, EV_FAILED, FILE, IMAGE, LIST_REPLY, LOCATION, REACTION, REPLY, TEMPLATE_BUTTON, TEXT, USER_EVENT,
} from './fixtures.js'

const TOKEN = 'cb-secret-123'

function make(responder?: (c: Call) => FakeResponse, extra: Record<string, unknown> = {}) {
  const { calls, http } = fakeHttp(responder ?? (() => ({ json: { status: 'submitted', messageId: 'ee4a68a0-1203-4c85-8dc3-49d0b3226a35' } })))
  const provider = new GupshupProvider({
    apiKey: 'gs-api-key', appName: 'DemoApp', source: '917834811114', webhookToken: TOKEN, http, ...extra,
  })
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  return { provider, calls, events }
}

const authed = { 'x-webhook-token': TOKEN }
const json = (v: unknown) => Buffer.from(JSON.stringify(v))
const form = (body: string) => Object.fromEntries(new URLSearchParams(body))

describe('GupshupProvider — construction & lifecycle', () => {
  it('requires credentials and a webhook token (or explicit unsigned mode)', () => {
    expect(() => new GupshupProvider({ apiKey: '', appName: 'a', source: '1', webhookToken: 't' })).toThrow(/apiKey/)
    expect(() => new GupshupProvider({ apiKey: 'k', appName: '', source: '1', webhookToken: 't' })).toThrow(/appName/)
    expect(() => new GupshupProvider({ apiKey: 'k', appName: 'a', source: '', webhookToken: 't' })).toThrow(/source/)
    expect(() => new GupshupProvider({ apiKey: 'k', appName: 'a', source: '1' })).toThrow(/webhookToken/)
    expect(() => new GupshupProvider({ apiKey: 'k', appName: 'a', source: '1', allowUnsignedWebhooks: true })).not.toThrow()
  })

  it('capabilities, selfId and lifecycle', async () => {
    const { provider, events } = make()
    expect(provider.id).toBe('gupshup')
    expect(provider.selfId).toBe('917834811114')
    expect(provider.capabilities).toMatchObject({ pushIngress: true, buttons: true, lists: true, templates: true })
    await provider.start()
    await provider.stop()
    expect(events.map((e) => e.kind === 'connection' && e.update.state)).toEqual(['ready', 'closed'])
  })
})

describe('GupshupProvider — callback authentication', () => {
  it('accepts the token in the header (ingest) or the URL query (ingestRequest)', () => {
    const { provider, events } = make()
    expect(provider.ingest(json(TEXT), authed)).toBe(200)
    expect(provider.ingestRequest({ url: `/gupshup?token=${TOKEN}`, body: json(TEXT) })).toBe(200)
    expect(provider.ingestRequest({ url: `https://bot.example.com/gupshup?token=${TOKEN}`, body: TEXT })).toBe(200)
    expect(events).toHaveLength(3)
  })

  it('rejects a missing or wrong token with 401 and emits nothing', () => {
    const { provider, events } = make()
    expect(provider.ingest(json(TEXT), {})).toBe(401)
    expect(provider.ingest(json(TEXT), { 'x-webhook-token': 'nope' })).toBe(401)
    expect(provider.ingestRequest({ url: '/gupshup?token=wrong', body: json(TEXT) })).toBe(401)
    expect(provider.ingestRequest({ url: '/gupshup', body: json(TEXT) })).toBe(401)
    expect(events).toHaveLength(0)
  })

  it('honours custom header / param names', () => {
    const { provider } = make(undefined, { webhookTokenHeader: 'Authorization', webhookTokenParam: 'k' })
    expect(provider.ingest(json(TEXT), { authorization: TOKEN })).toBe(200)
    expect(provider.ingestRequest({ url: `/cb?k=${TOKEN}`, body: json(TEXT) })).toBe(200)
  })

  it('400 for malformed JSON; 200 for the empty validation ping', () => {
    const { provider } = make()
    expect(provider.ingest('{oops', authed)).toBe(400)
    expect(provider.ingest('', authed)).toBe(200)
  })
})

describe('GupshupProvider — inbound normalization', () => {
  function one(cb: unknown) {
    const ctx = make()
    expect(ctx.provider.ingest(json(cb), authed)).toBe(200)
    return ctx.events
  }

  it('text → message keyed by sender.phone with the WhatsApp message id', () => {
    const [e] = one(TEXT)
    if (e?.kind !== 'message') throw new Error('expected message')
    expect(e.message).toMatchObject({
      chatId: '918x98xx21x4', senderId: '918x98xx21x4', from: '918x98xx21x4', body: 'Hi', type: 'text',
      ref: { id: 'ABEGkYaYVSEEAhAL3SLAWwHKeKrt6s3FKB0c' }, timestamp: 1580227766370, isGroup: false, fromMe: false,
    })
    expect(e.message.senderInfo).toMatchObject({ displayName: 'Smit', platformData: { countryCode: '91' } })
  })

  it('image / file → lazy MediaRef with mimetype, filename, caption as body', () => {
    const [img] = one(IMAGE)
    if (img?.kind !== 'message') throw new Error('expected message')
    expect(img.message.type).toBe('image')
    expect(img.message.body).toBe('Sample image')
    expect(img.message.media).toMatchObject({ kind: 'image', mimetype: 'image/jpeg', token: { url: IMAGE.payload.payload.url, expiresAt: 1718608420228 } })
    const [doc] = one(FILE)
    if (doc?.kind !== 'message') throw new Error('expected message')
    expect(doc.message.type).toBe('document')
    expect(doc.message.media).toMatchObject({ kind: 'document', filename: 'IMG_0068.PNG' })
  })

  it('location → type location', () => {
    const [e] = one(LOCATION)
    if (e?.kind !== 'message') throw new Error('expected message')
    expect(e.message.type).toBe('location')
    // Gupshup sends the coordinates as strings.
    expect(e.message.location).toEqual({ latitude: 19.1453658, longitude: 72.8552172 })
  })

  it('reply context → quoted ref keyed by the Gupshup id (what send() returned)', () => {
    const [e] = one(REPLY)
    if (e?.kind !== 'message') throw new Error('expected message')
    expect(e.message.quoted?.ref?.id).toBe('9b71295f-f7af-4c1f-b2b4-31b4a4867bad')
  })

  it('button_reply / list_reply / template button → interactions with the postback as data', () => {
    const [b] = one(BUTTON_REPLY)
    if (b?.kind !== 'interaction') throw new Error('expected interaction')
    expect(b.interaction).toMatchObject({ kind: 'button', data: 'confirm_yes', interactionId: 'ABEGkbutton', senderId: '918x98xx21x4' })
    const [l] = one(LIST_REPLY)
    if (l?.kind !== 'interaction') throw new Error('expected interaction')
    expect(l.interaction).toMatchObject({ kind: 'list', data: 'row_2' })
    const [t] = one(TEMPLATE_BUTTON)
    if (t?.kind !== 'interaction') throw new Error('expected interaction')
    expect(t.interaction).toMatchObject({ kind: 'button', data: 'View Account Balance' })
  })

  it('reaction → reaction event on our message (gsId)', () => {
    expect(one(REACTION)).toEqual([{ kind: 'reaction', reaction: { ref: { id: 'd8b6b10a', chatId: '918x98xx21x4' }, emoji: '❤️', senderId: '918x98xx21x4' } }])
  })

  it('message-events → status keyed by gsId; failed carries code + reason; enqueued dropped', () => {
    const [d] = one(EV_DELIVERED)
    if (d?.kind !== 'status') throw new Error('expected status')
    expect(d.status).toMatchObject({ ref: { id: 'ee4a68a0-1203-4c85-8dc3-49d0b3226a35' }, status: 'delivered', recipient: '918x98xx21x4' })
    const [f] = one(EV_FAILED)
    if (f?.kind !== 'status') throw new Error('expected status')
    expect(f.status).toMatchObject({ status: 'failed', error: { code: 470 } })
    expect(one(EV_ENQUEUED)).toEqual([])
    expect(one(USER_EVENT)).toEqual([])
  })
})

describe('GupshupProvider — config defaults', () => {
  it('an explicit undefined in the config keeps the defaults', async () => {
    const { provider, calls, events } = make(undefined, { baseUrl: undefined, webhookTokenHeader: undefined, webhookTokenParam: undefined })
    expect(provider.ingest(json(TEXT), authed)).toBe(200)
    expect(provider.ingestRequest({ url: `/gupshup?token=${TOKEN}`, body: json(TEXT) })).toBe(200)
    expect(provider.ingestRequest({ url: '/gupshup?undefined=x', body: json(TEXT) })).toBe(401)
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(2)
    await provider.send('9', { kind: 'text', text: 'Hola' })
    expect(calls[0]!.url).toBe('https://api.gupshup.io/wa/api/v1/msg')
  })
})

describe('GupshupProvider — outbound', () => {
  it('POSTs /wa/api/v1/msg form-encoded with apikey header', async () => {
    const { provider, calls } = make()
    const res = await provider.send('918x98xx21x4', { kind: 'text', text: 'Hola' })
    expect(res.ref).toMatchObject({ id: 'ee4a68a0-1203-4c85-8dc3-49d0b3226a35', chatId: '918x98xx21x4' })
    const call = calls[0]!
    expect(call.url).toBe('https://api.gupshup.io/wa/api/v1/msg')
    expect(call.headers.get('apikey')).toBe('gs-api-key')
    const f = form(call.body)
    expect(f).toMatchObject({ channel: 'whatsapp', source: '917834811114', destination: '918x98xx21x4', 'src.name': 'DemoApp' })
    expect(JSON.parse(f['message']!)).toEqual({ type: 'text', text: 'Hola' })
  })

  it('media message objects follow the documented shapes', async () => {
    const { provider, calls } = make()
    await provider.send('9', { kind: 'image', media: 'https://cdn.example.com/a.jpg', caption: 'c' })
    await provider.send('9', { kind: 'document', media: { url: 'https://cdn.example.com/f.pdf' }, filename: 'f.pdf' })
    await provider.send('9', { kind: 'voice', media: 'https://cdn.example.com/v.ogg' })
    const msgs = calls.map((c) => JSON.parse(form(c.body)['message']!))
    expect(msgs[0]).toEqual({ type: 'image', originalUrl: 'https://cdn.example.com/a.jpg', previewUrl: 'https://cdn.example.com/a.jpg', caption: 'c' })
    expect(msgs[1]).toEqual({ type: 'file', url: 'https://cdn.example.com/f.pdf', filename: 'f.pdf' })
    expect(msgs[2]).toEqual({ type: 'audio', url: 'https://cdn.example.com/v.ogg' })
    await expect(provider.send('9', { kind: 'image', media: Buffer.from('x') })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('buttons → quick_reply (≤3), list (≤10), numbered text otherwise; list kind → interactive list', async () => {
    const { provider, calls } = make()
    const btn = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `B${i}` }))
    await provider.send('9', { kind: 'buttons', text: '¿Sí?', buttons: btn(2) })
    await provider.send('9', { kind: 'buttons', text: 'Elige', buttons: btn(5) })
    await provider.send('9', { kind: 'buttons', text: 'Muchos', buttons: btn(11) })
    await provider.send('9', { kind: 'list', text: 'Menú', buttonText: 'Ver', sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Uno', description: 'd' }] }] })
    const msgs = calls.map((c) => JSON.parse(form(c.body)['message']!))
    expect(msgs[0]).toEqual({
      type: 'quick_reply', content: { type: 'text', text: '¿Sí?' },
      options: [{ type: 'text', title: 'B0', postbackText: 'b0' }, { type: 'text', title: 'B1', postbackText: 'b1' }],
    })
    expect(msgs[1].type).toBe('list')
    expect(msgs[1].items[0].options).toHaveLength(5)
    expect(msgs[2]).toMatchObject({ type: 'text' })
    expect(msgs[3]).toEqual({
      type: 'list', body: 'Menú', globalButtons: [{ type: 'text', title: 'Ver' }],
      items: [{ title: 'S', options: [{ type: 'text', title: 'Uno', description: 'd', postbackText: 'r1' }] }],
    })
  })

  it('templates go to /wa/api/v1/template/msg with { id, params }', async () => {
    const { provider, calls } = make()
    await provider.send('9', { kind: 'template', name: 'tpl-uuid', language: 'es', components: ['Ana', 42] })
    expect(calls[0]!.url).toBe('https://api.gupshup.io/wa/api/v1/template/msg')
    expect(JSON.parse(form(calls[0]!.body)['template']!)).toEqual({ id: 'tpl-uuid', params: ['Ana', '42'] })
    await expect(provider.send('9', { kind: 'template', name: 't', language: 'es', components: { foo: 1 } })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('location / contact / native message objects; poll and foreign native rejected', async () => {
    const { provider, calls } = make()
    await provider.send('9', { kind: 'location', lat: 19.07, lng: 72.87, name: 'Mumbai' })
    await provider.send('9', { kind: 'contact', phone: '+5730011', displayName: 'Ana' })
    await provider.send('9', { kind: 'native', provider: 'gupshup', payload: { type: 'text', text: 'raw' } })
    const msgs = calls.map((c) => JSON.parse(form(c.body)['message']!))
    expect(msgs[0]).toEqual({ type: 'location', longitude: 72.87, latitude: 19.07, name: 'Mumbai' })
    expect(msgs[1].contact.phones).toEqual([{ phone: '+5730011', type: 'Mobile' }])
    expect(msgs[2]).toEqual({ type: 'text', text: 'raw' })
    await expect(provider.send('9', { kind: 'poll', question: 'q', options: [] })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(provider.send('9', { kind: 'native', provider: 'meta', payload: {} })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('platformData overrides form fields (e.g. a second business number)', async () => {
    const { provider, calls } = make()
    await provider.send('9', { kind: 'text', text: 'x' }, { platformData: { source: '911111111111' } })
    expect(form(calls[0]!.body)['source']).toBe('911111111111')
  })

  it('maps failures to typed ProviderErrors (HTTP and status:error bodies)', async () => {
    const fail = (status: number, body: unknown, headers?: Record<string, string>) =>
      make(() => ({ status, json: body, ...(headers ? { headers } : {}) })).provider
        .send('9', { kind: 'text', text: 'x' }).then(() => undefined, (e: unknown) => e)
    const limited = await fail(429, { status: 'error', message: 'Too Many Requests' }, { 'Retry-After': '2' })
    expect(limited).toBeInstanceOf(RateLimitedError)
    expect((limited as RateLimitedError).retryAfterMs).toBe(2000)
    expect(await fail(200, { status: 'error', message: 'User is not Opted in and Inactive' })).toBeInstanceOf(RecipientUnreachableError)
    expect(await fail(400, { status: 'error', message: 'Message failed: more than 24 hours have passed' })).toBeInstanceOf(OutsideSessionWindowError)
    const auth = await fail(401, { status: 'error', message: 'Authentication Failed' })
    expect(auth).toBeInstanceOf(GupshupApiError)
    expect(auth).toBeInstanceOf(ProviderError)
    expect((auth as GupshupApiError).status).toBe(401)
  })
})

describe('GupshupProvider — media', () => {
  it('downloads via secureFetch without leaking the API key; blocks private hosts', async () => {
    const bytes = Buffer.from('IMG')
    const ok = make(() => ({ bytes }))
    expect((await ok.provider.downloadMedia({ kind: 'image', token: { url: IMAGE.payload.payload.url } })).equals(bytes)).toBe(true)
    expect(ok.calls[0]!.headers.get('apikey')).toBeNull()
    const { http } = fakeHttp()
    const blocked = new GupshupProvider({ apiKey: 'k', appName: 'a', source: '1', webhookToken: 't', http: { ...http, resolver: async () => ['192.168.1.4'] } })
    await expect(blocked.downloadMedia({ kind: 'image', token: { url: 'https://evil.example.com/x' } })).rejects.toThrow()
    await expect(blocked.downloadMedia({ kind: 'image', token: null })).rejects.toBeInstanceOf(ProviderError)
  })
})

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type P = IProvider<GupshupCallback>
type Method = { [K in keyof P]-?: NonNullable<P[K]> extends (...args: never[]) => unknown ? K : never }[keyof P]
type Divergent<C> = {
  [K in Method & keyof C]-?: C[K] extends (...args: infer A) => unknown ? (Equals<A, Parameters<NonNullable<P[K]>>> extends true ? never : K) : K
}[Method & keyof C]

describe('GupshupProvider — IProvider contract', () => {
  it('matches IProvider exactly', () => {
    expectTypeOf<GupshupProvider>().toExtend<IProvider>()
    expectTypeOf<Divergent<GupshupProvider>>().toEqualTypeOf<never>()
  })

  it('drives a Bot: callback → handler → reply; button click reaches the handler as body', async () => {
    const { provider, calls } = make()
    const bot = new Bot({ provider })
    bot.when('hi', async (ctx) => { await ctx.reply('Hola 👋') })
    bot.when('confirm_yes', async (ctx) => { await ctx.reply('Confirmado') })
    await bot.start()
    expect(provider.ingest(json(TEXT), authed)).toBe(200)
    await expect.poll(() => calls.length).toBe(1)
    expect(provider.ingest(json(BUTTON_REPLY), authed)).toBe(200)
    await expect.poll(() => calls.length).toBe(2)
    const texts = calls.map((c) => JSON.parse(form(c.body)['message']!).text)
    expect(texts).toEqual(['Hola 👋', 'Confirmado'])
    expect(form(calls[0]!.body)['destination']).toBe('918x98xx21x4')
    await bot.stop()
  })
})
