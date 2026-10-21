import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  Bot,
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type IProvider,
  type InboundEvent,
} from '@botmesh/core'
import { GoHighLevelProvider } from '../src/GoHighLevelProvider.js'
import { GoHighLevelApiError } from '../src/errors.js'
import { GHL_WEBHOOK_PUBLIC_KEY, verifyGhlSignature } from '../src/signature.js'
import type { GhlWebhookBody } from '../src/types.js'
import { fakeHttp, type Call, type FakeResponse } from './support.js'
import { CALL_INBOUND, keys, LOCATION, OUTBOUND_ECHO, SMS_INBOUND, WHATSAPP_IMAGE } from './fixtures.js'

const K = keys()

function make(responder?: (c: Call) => FakeResponse, extra: Record<string, unknown> = {}) {
  const { calls, http } = fakeHttp(responder ?? (() => ({ json: { conversationId: 'conv-1', messageId: 'out-1' } })))
  const provider = new GoHighLevelProvider({
    accessToken: 'pit-token', locationId: LOCATION, publicKey: K.publicKey, http, ...extra,
  })
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  return { provider, calls, events }
}

function signed(payload: unknown) {
  const raw = JSON.stringify(payload)
  return { raw: Buffer.from(raw), headers: { 'x-ghl-signature': K.signEd(raw), 'content-type': 'application/json' } }
}

describe('GoHighLevelProvider — construction & lifecycle', () => {
  it('requires accessToken and locationId', () => {
    expect(() => new GoHighLevelProvider({ accessToken: '', locationId: 'x' })).toThrow(/accessToken/)
    expect(() => new GoHighLevelProvider({ accessToken: 'x', locationId: '' })).toThrow(/locationId/)
  })

  it('exposes capabilities and lifecycle states', async () => {
    const { provider, events } = make()
    expect(provider.id).toBe('gohighlevel')
    expect(provider.capabilities).toMatchObject({ pushIngress: true, readReceipts: true, templates: true, typing: false, buttons: false })
    await provider.start()
    await provider.stop()
    expect(events.map((e) => e.kind === 'connection' && e.update.state)).toEqual(['ready', 'closed'])
  })
})

describe('GoHighLevelProvider — webhook signature (X-GHL-Signature, Ed25519)', () => {
  it('ships HighLevel\'s published Ed25519 key as the default', () => {
    expect(GHL_WEBHOOK_PUBLIC_KEY).toContain('MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=')
    // A signature from any other key does not verify against the default key.
    const raw = Buffer.from('{"a":1}')
    expect(verifyGhlSignature({ rawBody: raw, ghlSignature: K.signEd('{"a":1}') }).ok).toBe(false)
  })

  it('accepts a correctly signed raw body (Buffer or string)', () => {
    const { provider, events } = make()
    const { raw, headers } = signed(SMS_INBOUND)
    expect(provider.ingest(raw, headers)).toBe(200)
    expect(provider.ingest(raw.toString('utf8'), headers)).toBe(200)
    expect(events).toHaveLength(2)
  })

  it('rejects a tampered body, a missing / N/A / garbage signature with 401', () => {
    const { provider, events } = make()
    const { raw, headers } = signed(SMS_INBOUND)
    expect(provider.ingest(Buffer.from(raw.toString().replace('hola', 'hack')), headers)).toBe(401)
    expect(provider.ingest(raw, {})).toBe(401)
    expect(provider.ingest(raw, { 'x-ghl-signature': 'N/A' })).toBe(401)
    expect(provider.ingest(raw, { 'x-ghl-signature': '%%%' })).toBe(401)
    expect(events).toHaveLength(0)
  })

  it('verifies over the RAW bytes: whitespace changes break the signature', () => {
    const { provider } = make()
    const raw = JSON.stringify(SMS_INBOUND, null, 2)
    const headers = { 'x-ghl-signature': K.signEd(raw) }
    expect(provider.ingest(Buffer.from(raw), headers)).toBe(200)
    expect(provider.ingest(Buffer.from(JSON.stringify(SMS_INBOUND)), headers)).toBe(401)
  })

  it('refuses an already-parsed object when signatures are on (400)', () => {
    const { provider } = make()
    expect(provider.ingest({ ...SMS_INBOUND }, signed(SMS_INBOUND).headers)).toBe(400)
  })

  it('legacy X-WH-Signature (RSA-SHA256) only verifies when a legacy key is configured', () => {
    const raw = JSON.stringify(SMS_INBOUND)
    const headers = { 'x-wh-signature': K.signRsa(raw) }
    expect(make().provider.ingest(Buffer.from(raw), headers)).toBe(401)
    expect(make(undefined, { legacyPublicKey: K.legacyPublicKey }).provider.ingest(Buffer.from(raw), headers)).toBe(200)
  })

  it('X-GHL-Signature wins over the legacy header when both are present', () => {
    const raw = JSON.stringify(SMS_INBOUND)
    const { provider } = make(undefined, { legacyPublicKey: K.legacyPublicKey })
    expect(provider.ingest(Buffer.from(raw), { 'x-ghl-signature': 'AAAA', 'x-wh-signature': K.signRsa(raw) })).toBe(401)
  })

  it('allowUnsignedWebhooks accepts parsed objects (local dev only); malformed JSON → 400', () => {
    const { provider, events } = make(undefined, { allowUnsignedWebhooks: true })
    expect(provider.ingest({ ...SMS_INBOUND })).toBe(200)
    expect(provider.ingest('{nope')).toBe(400)
    expect(events).toHaveLength(1)
  })
})

describe('GoHighLevelProvider — inbound normalization', () => {
  function one(payload: unknown) {
    const ctx = make()
    const { raw, headers } = signed(payload)
    expect(ctx.provider.ingest(raw, headers)).toBe(200)
    return ctx
  }

  it('InboundMessage → message keyed by the stable contactId', () => {
    const { events } = one(SMS_INBOUND)
    const e = events[0]!
    if (e.kind !== 'message') throw new Error('expected message')
    expect(e.message).toMatchObject({
      chatId: 'cI08i1Bls3iTB9bKgFJh', senderId: 'cI08i1Bls3iTB9bKgFJh', from: 'cI08i1Bls3iTB9bKgFJh',
      body: 'hola', type: 'text', isGroup: false, fromMe: false,
      ref: { id: 'msg-sms-1', chatId: 'cI08i1Bls3iTB9bKgFJh' },
      timestamp: Date.parse('2021-04-21T11:31:45.750Z'),
    })
    expect(e.message.chat.platformData).toMatchObject({ channel: 'SMS', conversationId: 'fcanlLgpbQgQhderivVs', from: '+15551234567' })
  })

  it('the same contact on another channel stays the same chat/sender', () => {
    const { events } = one(WHATSAPP_IMAGE)
    const e = events[0]!
    if (e.kind !== 'message') throw new Error('expected message')
    expect(e.message.senderId).toBe(SMS_INBOUND.contactId)
    expect(e.message.chat.platformData?.['channel']).toBe('WhatsApp')
  })

  it('attachments → lazy MediaRef (kind from the extension)', () => {
    const { events } = one(WHATSAPP_IMAGE)
    const e = events[0]!
    if (e.kind !== 'message') throw new Error('expected message')
    expect(e.message.type).toBe('image')
    expect(e.message.media).toEqual({ kind: 'image', token: { url: WHATSAPP_IMAGE.attachments[0] } })
  })

  it('CALL → call event from the contact', () => {
    const { events } = one(CALL_INBOUND)
    expect(events).toEqual([{ kind: 'call', event: { id: 'call-1', from: CALL_INBOUND.contactId, status: 'completed', chatId: CALL_INBOUND.contactId, isGroup: false } }])
  })

  it('ignores outbound echoes, other event types and other locations', () => {
    expect(one(OUTBOUND_ECHO).events).toHaveLength(0)
    expect(one({ type: 'ContactCreate', locationId: LOCATION, id: 'c1' }).events).toHaveLength(0)
    expect(one({ ...SMS_INBOUND, locationId: 'other-location' }).events).toHaveLength(0)
  })

  it('without messageId falls back to webhookId (redelivery-stable), else empty id', () => {
    const noId: Record<string, unknown> = { ...SMS_INBOUND, webhookId: 'wh-1' }
    delete noId['messageId']
    const a = one(noId).events[0]!
    if (a.kind !== 'message') throw new Error('expected message')
    expect(a.message.ref.id).toBe('wh-1')
    delete noId['webhookId']
    const b = one(noId).events[0]!
    if (b.kind !== 'message') throw new Error('expected message')
    expect(b.message.ref.id).toBe('')
  })
})

describe('GoHighLevelProvider — per-chat text format', () => {
  it('follows the channel replies go out on: WhatsApp markup, plain elsewhere', () => {
    const { provider } = make()
    expect(provider.capabilities.textFormat).toBeUndefined()
    // Unknown contact → defaultChannel (SMS).
    expect(provider.textFormatFor('nobody')).toBe('plain')
    const { raw, headers } = signed(WHATSAPP_IMAGE)
    expect(provider.ingest(raw, headers)).toBe(200)
    expect(provider.textFormatFor(WHATSAPP_IMAGE.contactId)).toBe('whatsapp')
    const sms = signed(SMS_INBOUND)
    expect(provider.ingest(sms.raw, sms.headers)).toBe(200)
    expect(provider.textFormatFor(SMS_INBOUND.contactId)).toBe('plain')
  })

  it('maps every channel; an unknown one is left to the caller', () => {
    for (const [channel, format] of [
      ['WhatsApp', 'whatsapp'], ['SMS', 'plain'], ['Email', 'plain'], ['FB', 'plain'], ['IG', 'plain'],
      ['Live_Chat', 'plain'], ['GMB', 'plain'], ['Custom', 'plain'], ['Telepathy', undefined],
    ] as const) {
      expect(make(undefined, { defaultChannel: channel }).provider.textFormatFor('x')).toBe(format)
    }
  })
})

describe('GoHighLevelProvider — config defaults', () => {
  it('an explicit undefined in the config keeps the defaults', async () => {
    const { provider, calls } = make(undefined, { apiVersion: undefined, baseUrl: undefined, defaultChannel: undefined })
    await provider.send('contact-1', { kind: 'text', text: 'hola' })
    const call = calls[0]!
    expect(call.url).toBe('https://services.leadconnectorhq.com/conversations/messages')
    expect(call.headers.get('version')).toBe('2021-04-15')
    expect(JSON.parse(call.body)).toEqual({ type: 'SMS', contactId: 'contact-1', message: 'hola' })
  })
})

describe('GoHighLevelProvider — outbound', () => {
  it('POSTs /conversations/messages with Bearer + Version headers on the default channel', async () => {
    const { provider, calls } = make()
    const res = await provider.send('contact-1', { kind: 'text', text: 'hola' })
    expect(res.ref).toMatchObject({ id: 'out-1', chatId: 'contact-1', native: { conversationId: 'conv-1', channel: 'SMS' } })
    const call = calls[0]!
    expect(call.url).toBe('https://services.leadconnectorhq.com/conversations/messages')
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe('Bearer pit-token')
    expect(call.headers.get('version')).toBe('2021-04-15')
    expect(JSON.parse(call.body)).toEqual({ type: 'SMS', contactId: 'contact-1', message: 'hola' })
  })

  it('replies on the channel the contact last used', async () => {
    const { provider, calls } = make()
    const { raw, headers } = signed(WHATSAPP_IMAGE)
    provider.ingest(raw, headers)
    await provider.send(WHATSAPP_IMAGE.contactId, { kind: 'text', text: 'ok' })
    expect(JSON.parse(calls[0]!.body).type).toBe('WhatsApp')
  })

  it('platformData overrides the channel and passes extra fields; quoted → replyMessageId', async () => {
    const { provider, calls } = make()
    await provider.send('c1', { kind: 'text', text: 'Hola\n<b>' }, {
      platformData: { type: 'Email', subject: 'Pedido' },
      quoted: { id: 'm-9', chatId: 'c1' },
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      type: 'Email', contactId: 'c1', message: 'Hola\n<b>', subject: 'Pedido', replyMessageId: 'm-9', html: 'Hola<br>&lt;b&gt;',
    })
  })

  it('media → attachments URL + caption; non-URL media rejected', async () => {
    const { provider, calls } = make()
    await provider.send('c1', { kind: 'document', media: 'https://cdn.example.com/f.pdf', caption: 'factura' })
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ attachments: ['https://cdn.example.com/f.pdf'], message: 'factura' })
    await expect(provider.send('c1', { kind: 'image', media: { path: '/tmp/x.png' } })).rejects.toBeInstanceOf(UnsupportedContentError)
    expect(calls).toHaveLength(1)
  })

  it('buttons degrade to numbered text; template → templateId; unsupported kinds rejected', async () => {
    const { provider, calls } = make()
    await provider.send('c1', { kind: 'list', text: 'Menú', buttonText: 'Ver', sections: [{ rows: [{ id: 'a', title: 'Uno' }, { id: 'b', title: 'Dos' }] }] })
    expect(JSON.parse(calls[0]!.body).message).toBe('Menú\n\n1. Uno\n2. Dos')
    await provider.send('c1', { kind: 'template', name: 'tpl-1', language: 'es' })
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ templateId: 'tpl-1' })
    await expect(provider.send('c1', { kind: 'location', lat: 1, lng: 2 })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(provider.send('c1', { kind: 'native', provider: 'twilio', payload: {} })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('maps HTTP errors to typed ProviderErrors', async () => {
    const fail = (status: number, json: unknown, headers?: Record<string, string>) =>
      make(() => ({ status, json, ...(headers ? { headers } : {}) })).provider
        .send('c1', { kind: 'text', text: 'x' }).then(() => undefined, (e: unknown) => e)
    const limited = await fail(429, { message: 'Too many requests' }, { 'Retry-After': '3' })
    expect(limited).toBeInstanceOf(RateLimitedError)
    expect((limited as RateLimitedError).retryAfterMs).toBe(3000)
    expect(await fail(404, { statusCode: 404, message: 'Contact not found' })).toBeInstanceOf(RecipientUnreachableError)
    expect(await fail(400, { statusCode: 400, message: 'Contact has DND enabled for SMS' })).toBeInstanceOf(RecipientUnreachableError)
    expect(await fail(413, {})).toBeInstanceOf(PayloadTooLargeError)
    const other = await fail(401, { statusCode: 401, message: ['Invalid JWT'] })
    expect(other).toBeInstanceOf(GoHighLevelApiError)
    expect(other).toBeInstanceOf(ProviderError)
    expect((other as GoHighLevelApiError).status).toBe(401)
    expect((other as Error).message).toContain('Invalid JWT')
    // Auth failures say what to check.
    expect((other as Error).message).toMatch(/accessToken/)
  })
})

describe('GoHighLevelProvider — markRead & media', () => {
  it('markRead PUTs unreadCount 0 once per conversation; refs without one are skipped', async () => {
    const { provider, calls } = make(() => ({ json: { success: true } }))
    await provider.markRead([
      { id: 'a', chatId: 'c1', native: { conversationId: 'conv-1' } },
      { id: 'b', chatId: 'c1', native: { conversationId: 'conv-1' } },
      { id: 'c', chatId: 'c2' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.url).toBe('https://services.leadconnectorhq.com/conversations/conv-1')
    expect(JSON.parse(calls[0]!.body)).toEqual({ locationId: LOCATION, unreadCount: 0 })
  })

  it('downloads attachments through secureFetch and blocks private hosts', async () => {
    const bytes = Buffer.from('IMG')
    const ok = make(() => ({ bytes }))
    expect((await ok.provider.downloadMedia({ kind: 'image', token: { url: 'https://cdn.example.com/a.jpg' } })).equals(bytes)).toBe(true)
    expect(ok.calls[0]!.headers.get('authorization')).toBeNull()
    const { http } = fakeHttp()
    const blocked = new GoHighLevelProvider({ accessToken: 't', locationId: LOCATION, http: { ...http, resolver: async () => ['127.0.0.1'] } })
    await expect(blocked.downloadMedia({ kind: 'image', token: { url: 'https://evil.example.com/a' } })).rejects.toThrow()
    await expect(blocked.downloadMedia({ kind: 'image', token: 42 })).rejects.toBeInstanceOf(ProviderError)
  })
})

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type P = IProvider<GhlWebhookBody>
type Method = { [K in keyof P]-?: NonNullable<P[K]> extends (...args: never[]) => unknown ? K : never }[keyof P]
type Divergent<C> = {
  [K in Method & keyof C]-?: C[K] extends (...args: infer A) => unknown ? (Equals<A, Parameters<NonNullable<P[K]>>> extends true ? never : K) : K
}[Method & keyof C]

describe('GoHighLevelProvider — IProvider contract', () => {
  it('matches IProvider exactly', () => {
    expectTypeOf<GoHighLevelProvider>().toExtend<IProvider>()
    expectTypeOf<Divergent<GoHighLevelProvider>>().toEqualTypeOf<never>()
  })

  it('drives a Bot end to end (signed webhook → handler → reply on the same channel)', async () => {
    const { provider, calls } = make()
    const bot = new Bot({ provider })
    bot.when('hola', async (ctx) => { await ctx.reply('¡Hola desde HighLevel!') })
    await bot.start()
    const { raw, headers } = signed(WHATSAPP_IMAGE.body === 'hola' ? WHATSAPP_IMAGE : { ...WHATSAPP_IMAGE, body: 'hola', attachments: [] })
    expect(provider.ingest(raw, headers)).toBe(200)
    await expect.poll(() => calls.length).toBe(1)
    expect(JSON.parse(calls[0]!.body)).toEqual({ type: 'WhatsApp', contactId: SMS_INBOUND.contactId, message: '¡Hola desde HighLevel!' })
    await bot.stop()
  })
})
