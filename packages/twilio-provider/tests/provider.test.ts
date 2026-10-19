import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  OutsideSessionWindowError,
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type InboundEvent,
} from '@bot-wa/core'
import { TwilioProvider } from '../src/TwilioProvider.js'
import { computeTwilioSignature, parseFormParams } from '../src/signature.js'
import { TwilioApiError } from '../src/errors.js'
import { fakeHttp, type FakeResponse, type Call } from './support.js'
import {
  form, SMS_TEXT, STATUS_DELIVERED, STATUS_UNDELIVERED, WA_BSUID_TEXT, WA_BUTTON, WA_IMAGE, WA_LOCATION, WA_REPLY, WA_TEXT,
} from './fixtures.js'

const SID = 'AC00000000000000000000000000000000'
const TOKEN = 'auth-token-secret'
const HOOK = 'https://bot.example.com/twilio/webhook'

function make(responder?: (c: Call) => FakeResponse, extra: Record<string, unknown> = {}) {
  const { calls, http } = fakeHttp(responder ?? (() => ({ status: 201, json: { sid: 'SMout', status: 'queued' } })))
  const provider = new TwilioProvider({
    accountSid: SID, authToken: TOKEN,
    whatsappFrom: 'whatsapp:+14155238886', smsFrom: '+15017122661',
    webhookUrl: HOOK, http, ...extra,
  })
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  return { provider, calls, events }
}

function signed(params: Record<string, string>, url = HOOK) {
  return { body: form(params), headers: { 'x-twilio-signature': computeTwilioSignature(TOKEN, url, params), 'content-type': 'application/x-www-form-urlencoded' } }
}

describe('TwilioProvider — construction & lifecycle', () => {
  it('requires accountSid and authToken', () => {
    expect(() => new TwilioProvider({ accountSid: '', authToken: TOKEN })).toThrow(/accountSid/)
    expect(() => new TwilioProvider({ accountSid: SID, authToken: '' })).toThrow(/authToken/)
  })

  it('exposes webhook capabilities and emits ready/closed', async () => {
    const { provider, events } = make()
    expect(provider.id).toBe('twilio')
    expect(provider.capabilities.pushIngress).toBe(true)
    expect(provider.capabilities.templates).toBe(true)
    expect(provider.capabilities.maxTextLength).toBe(1600)
    expect(provider.capabilities.buttons).toBe(false)
    await provider.start()
    await provider.stop()
    expect(events.map((e) => e.kind === 'connection' && e.update.state)).toEqual(['ready', 'closed'])
  })
})

describe('TwilioProvider — config defaults', () => {
  it('an explicit undefined in the config keeps the defaults (no raw TypeError)', async () => {
    const { provider, calls } = make(undefined, { apiBaseUrl: undefined, messagingBaseUrl: undefined })
    await provider.send('whatsapp:+573001112233', { kind: 'text', text: 'hola' })
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`)
  })
})

describe('TwilioProvider — webhook signature', () => {
  it('accepts a correctly signed raw form body', () => {
    const { provider, events } = make()
    const { body, headers } = signed(WA_TEXT)
    expect(provider.ingest(body, headers)).toBe(200)
    expect(events).toHaveLength(1)
  })

  it('accepts a Buffer body and an already-parsed object body', () => {
    const { provider, events } = make()
    const { body, headers } = signed(WA_TEXT)
    expect(provider.ingest(Buffer.from(body), headers)).toBe(200)
    expect(provider.ingest({ ...WA_TEXT }, headers)).toBe(200)
    expect(events).toHaveLength(2)
  })

  it('rejects forged, tampered or unsigned requests with 403 and emits nothing', () => {
    const { provider, events } = make()
    const { body, headers } = signed(WA_TEXT)
    expect(provider.ingest(body.replace('hola', 'hack'), headers)).toBe(403)
    expect(provider.ingest(body, {})).toBe(403)
    expect(provider.ingest(body, { 'X-Twilio-Signature': 'AAAA' })).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('verifies against the EXACT configured URL (another path does not validate)', () => {
    const { provider } = make()
    const { body, headers } = signed(WA_TEXT, 'https://bot.example.com/other')
    expect(provider.ingest(body, headers)).toBe(403)
  })

  it('ingestRequest verifies against the URL the host passes (query included)', () => {
    const { provider, events } = make(undefined, { webhookUrl: undefined })
    const url = 'https://bot.example.com/t/tenant-1?x=1'
    const { body, headers } = signed(WA_TEXT, url)
    expect(provider.ingestRequest({ url, body, headers })).toBe(200)
    expect(provider.ingestRequest({ url: 'https://bot.example.com/t/tenant-2?x=1', body, headers })).toBe(403)
    expect(events).toHaveLength(1)
  })

  it('rebuilds the URL from webhookPath + Host / X-Forwarded-* headers', () => {
    const { provider } = make(undefined, { webhookUrl: undefined, webhookPath: '/twilio/webhook' })
    const { body, headers } = signed(WA_TEXT)
    expect(provider.ingest(body, { ...headers, host: 'internal:3000', 'x-forwarded-host': 'bot.example.com', 'x-forwarded-proto': 'https' })).toBe(200)
  })

  it('without any URL to verify against, rejects (403) instead of trusting the body', () => {
    const { provider } = make(undefined, { webhookUrl: undefined })
    const { body, headers } = signed(WA_TEXT)
    expect(provider.ingest(body, headers)).toBe(403)
  })

  it('JSON body: a URL-only signature without bodySHA256 never authenticates the body (403)', () => {
    const { provider, events } = make(undefined, { webhookUrl: undefined })
    const sig = computeTwilioSignature(TOKEN, HOOK, {})
    const forged = JSON.stringify({ ...WA_TEXT, Body: 'forged' })
    expect(provider.ingestRequest({ url: HOOK, body: forged, headers: { 'x-twilio-signature': sig, 'content-type': 'application/json' } })).toBe(403)
    expect(provider.ingestRequest({ url: HOOK, body: JSON.stringify({ ...WA_TEXT, MessageSid: 'SMother' }), headers: { 'x-twilio-signature': sig } })).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('ingest(): a JSON body signed over the bare webhookUrl is rejected (403)', () => {
    const { provider, events } = make()
    const sig = computeTwilioSignature(TOKEN, HOOK, {})
    const forged = JSON.stringify({ ...WA_TEXT, Body: 'forged' })
    expect(provider.ingest(forged, { 'x-twilio-signature': sig, 'content-type': 'application/json' })).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('ingest(): a real JSON webhook (bodySHA256 appended to webhookUrl) verifies against the configured URL', () => {
    const { provider, events } = make()
    const body = JSON.stringify(WA_TEXT)
    const hash = createHash('sha256').update(body).digest('hex')
    const sig = computeTwilioSignature(TOKEN, `${HOOK}?bodySHA256=${hash}`, {})
    expect(provider.ingest(body, { 'x-twilio-signature': sig, 'content-type': 'application/json' })).toBe(200)
    // Same signature, different body → the derived hash no longer matches what was signed.
    expect(provider.ingest(JSON.stringify({ ...WA_TEXT, Body: 'forged' }), { 'x-twilio-signature': sig, 'content-type': 'application/json' })).toBe(403)
    expect(events).toHaveLength(1)
  })

  it('ingestRequest(): a JSON webhook with bodySHA256 in the URL is accepted', () => {
    const { provider, events } = make(undefined, { webhookUrl: undefined })
    const body = JSON.stringify(WA_TEXT)
    const hash = createHash('sha256').update(body).digest('hex')
    const url = `https://bot.example.com/t/1?x=1&bodySHA256=${hash}`
    const sig = computeTwilioSignature(TOKEN, url, {})
    expect(provider.ingestRequest({ url, body, headers: { 'x-twilio-signature': sig, 'content-type': 'application/json' } })).toBe(200)
    expect(events).toHaveLength(1)
  })

  it('allowUnsignedWebhooks skips verification (local dev only)', () => {
    const { provider, events } = make(undefined, { allowUnsignedWebhooks: true })
    expect(provider.ingest(form(WA_TEXT))).toBe(200)
    expect(events).toHaveLength(1)
  })

  it('returns 400 for an unreadable body', () => {
    const { provider } = make()
    expect(provider.ingest(42, {})).toBe(400)
  })
})

describe('TwilioProvider — inbound normalization', () => {
  function ingestOne(params: Record<string, string>) {
    const ctx = make()
    const { body, headers } = signed(params)
    expect(ctx.provider.ingest(body, headers)).toBe(200)
    expect(ctx.events).toHaveLength(1)
    return { ...ctx, event: ctx.events[0]! }
  }

  it('WhatsApp text: stable chat/sender = From, ref = MessageSid, profile name', () => {
    const { event } = ingestOne(WA_TEXT)
    if (event.kind !== 'message') throw new Error('expected message')
    const m = event.message
    expect(m.chatId).toBe('whatsapp:+573001112233')
    expect(m.senderId).toBe('whatsapp:+573001112233')
    expect(m.from).toBe(m.chatId)
    expect(m.sender).toBe(m.senderId)
    expect(m.ref.id).toBe(WA_TEXT.MessageSid)
    expect(m.body).toBe('hola')
    expect(m.type).toBe('text')
    expect(m.isGroup).toBe(false)
    expect(m.chat.kind).toBe('dm')
    expect(m.senderInfo.displayName).toBe('Ana')
    expect(m.senderInfo.platformData).toEqual({ channel: 'whatsapp', waId: '573001112233' })
    expect(m.raw).toMatchObject({ Body: 'hola' })
  })

  it('SMS text: chat id is the bare E.164 number (separate chat from WhatsApp)', () => {
    const { event } = ingestOne(SMS_TEXT)
    if (event.kind !== 'message') throw new Error('expected message')
    expect(event.message.chatId).toBe('+15005550006')
    expect(event.message.chat.platformData).toMatchObject({ channel: 'sms', to: '+15017122661' })
  })

  it('media: first MediaUrl becomes a lazy MediaRef, caption stays in body', () => {
    const { event } = ingestOne(WA_IMAGE)
    if (event.kind !== 'message') throw new Error('expected message')
    expect(event.message.type).toBe('image')
    expect(event.message.body).toBe('mira')
    expect(event.message.media).toEqual({ kind: 'image', mimetype: 'image/jpeg', token: { url: WA_IMAGE.MediaUrl0 } })
  })

  it('quick-reply click → interaction with the ButtonPayload as data', () => {
    const { event } = ingestOne(WA_BUTTON)
    if (event.kind !== 'interaction') throw new Error('expected interaction')
    expect(event.interaction.kind).toBe('button')
    expect(event.interaction.data).toBe('confirm_yes')
    expect(event.interaction.interactionId).toBe(WA_BUTTON.MessageSid)
    expect(event.interaction.senderId).toBe('whatsapp:+573001112233')
  })

  it('list-picker click (ListId) → list interaction', () => {
    const { event } = ingestOne({ ...WA_TEXT, MessageSid: 'SMlist', ListId: 'row_2', ListTitle: 'Opción 2' })
    if (event.kind !== 'interaction') throw new Error('expected interaction')
    expect(event.interaction.kind).toBe('list')
    expect(event.interaction.data).toBe('row_2')
  })

  it('location share → type location with the address as body', () => {
    const { event } = ingestOne(WA_LOCATION)
    if (event.kind !== 'message') throw new Error('expected message')
    expect(event.message.type).toBe('location')
    expect(event.message.body).toBe('Bogotá')
  })

  it('reply context → quoted ref', () => {
    const { event } = ingestOne(WA_REPLY)
    if (event.kind !== 'message') throw new Error('expected message')
    expect(event.message.quoted).toEqual({
      ref: { id: 'SM99999999999999999999999999999999', chatId: 'whatsapp:+573001112233' },
      senderId: 'whatsapp:+14155238886',
    })
  })

  it('status callbacks → neutral status events (undelivered → failed with code)', () => {
    const a = ingestOne(STATUS_DELIVERED).event
    if (a.kind !== 'status') throw new Error('expected status')
    expect(a.status).toMatchObject({ ref: { id: STATUS_DELIVERED.MessageSid }, status: 'delivered', recipient: 'whatsapp:+573001112233' })
    const b = ingestOne(STATUS_UNDELIVERED).event
    if (b.kind !== 'status') throw new Error('expected status')
    expect(b.status).toMatchObject({ status: 'failed', error: { code: 63016, message: 'Outside the allowed window' } })
  })

  it('bookkeeping statuses (queued/sending) emit nothing', () => {
    const { provider, events } = make()
    const { body, headers } = signed({ ...STATUS_DELIVERED, MessageStatus: 'queued', SmsStatus: 'queued' })
    expect(provider.ingest(body, headers)).toBe(200)
    expect(events).toHaveLength(0)
  })

  it('a redelivered webhook carries the same ref id (core dedupe contract)', () => {
    const { provider, events } = make()
    const { body, headers } = signed(WA_TEXT)
    provider.ingest(body, headers)
    provider.ingest(body, headers)
    const ids = events.map((e) => (e.kind === 'message' ? e.message.ref.id : ''))
    expect(ids[0]).toBe(ids[1])
  })
})

describe('TwilioProvider — outbound', () => {
  it('POSTs form params to Messages.json with Basic auth', async () => {
    const { provider, calls } = make()
    const res = await provider.send('whatsapp:+573001112233', { kind: 'text', text: 'hola' })
    expect(res.ref.id).toBe('SMout')
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`)
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`)
    expect(parseFormParams(call.body)).toEqual({ To: 'whatsapp:+573001112233', From: 'whatsapp:+14155238886', Body: 'hola' })
  })

  it('picks the SMS sender for bare-number chats, and the API key when configured', async () => {
    const { provider, calls } = make(undefined, { apiKeySid: 'SKkey', apiKeySecret: 'secret' })
    await provider.send('+15005550006', { kind: 'text', text: 'x' })
    expect(parseFormParams(calls[0]!.body)['From']).toBe('+15017122661')
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('SKkey:secret').toString('base64')}`)
  })

  it('replies from the number the user wrote to (multi-number accounts)', async () => {
    const { provider, calls } = make()
    const { body, headers } = signed({ ...WA_TEXT, To: 'whatsapp:+14150000000' })
    provider.ingest(body, headers)
    await provider.send('whatsapp:+573001112233', { kind: 'text', text: 'x' })
    expect(parseFormParams(calls[0]!.body)['From']).toBe('whatsapp:+14150000000')
  })

  it('falls back to the Messaging Service when no number fits, and fails clearly without one', async () => {
    const svc = make(undefined, { whatsappFrom: undefined, messagingServiceSid: 'MGservice' })
    await svc.provider.send('whatsapp:+1', { kind: 'text', text: 'x' })
    expect(parseFormParams(svc.calls[0]!.body)['MessagingServiceSid']).toBe('MGservice')
    const none = make(undefined, { whatsappFrom: undefined })
    await expect(none.provider.send('whatsapp:+1', { kind: 'text', text: 'x' })).rejects.toThrow(/whatsappFrom/)
  })

  it('sends media by public URL with caption, plus StatusCallback when configured', async () => {
    const { provider, calls } = make(undefined, { statusCallback: 'https://bot.example.com/status' })
    await provider.send('whatsapp:+1', { kind: 'image', media: { url: 'https://cdn.example.com/a.jpg' }, caption: 'foto' })
    expect(parseFormParams(calls[0]!.body)).toMatchObject({
      MediaUrl: 'https://cdn.example.com/a.jpg', Body: 'foto', StatusCallback: 'https://bot.example.com/status',
    })
  })

  it('rejects non-URL media with UnsupportedContentError (no request)', async () => {
    const { provider, calls } = make()
    await expect(provider.send('whatsapp:+1', { kind: 'image', media: Buffer.from('x') })).rejects.toBeInstanceOf(UnsupportedContentError)
    expect(calls).toHaveLength(0)
  })

  it('templates → ContentSid + ContentVariables JSON', async () => {
    const { provider, calls } = make()
    await provider.send('whatsapp:+1', { kind: 'template', name: 'HXabc', language: 'es', components: { 1: 'Ana' } })
    expect(parseFormParams(calls[0]!.body)).toMatchObject({ ContentSid: 'HXabc', ContentVariables: '{"1":"Ana"}' })
  })

  it('buttons/list degrade to a numbered text menu', async () => {
    const { provider, calls } = make()
    await provider.send('whatsapp:+1', { kind: 'buttons', text: '¿Confirmas?', buttons: [{ id: 'y', title: 'Sí' }, { id: 'n', title: 'No' }] })
    expect(parseFormParams(calls[0]!.body)['Body']).toBe('¿Confirmas?\n\n1. Sí\n2. No')
  })

  it('location → PersistentAction geo URI', async () => {
    const { provider, calls } = make()
    await provider.send('whatsapp:+1', { kind: 'location', lat: 4.6, lng: -74.08, name: 'Oficina' })
    expect(parseFormParams(calls[0]!.body)).toMatchObject({ Body: 'Oficina', PersistentAction: 'geo:4.6,-74.08|Oficina' })
  })

  it('native payload params pass through; other providers\' native is rejected', async () => {
    const { provider, calls } = make()
    await provider.send('whatsapp:+1', { kind: 'native', provider: 'twilio', payload: { ContentSid: 'HX1', ShortenUrls: true } })
    expect(parseFormParams(calls[0]!.body)).toMatchObject({ ContentSid: 'HX1', ShortenUrls: 'true' })
    await expect(provider.send('whatsapp:+1', { kind: 'native', provider: 'discord', payload: {} })).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  it('rejects unsupported kinds and over-long bodies locally', async () => {
    const { provider, calls } = make()
    await expect(provider.send('whatsapp:+1', { kind: 'poll', question: 'q', options: ['a'] })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(provider.send('whatsapp:+1', { kind: 'contact', phone: '+1' })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(provider.send('whatsapp:+1', { kind: 'text', text: 'x'.repeat(1601) })).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(calls).toHaveLength(0)
  })
})

describe('TwilioProvider — typed errors', () => {
  async function failWith(status: number, json: unknown, headers?: Record<string, string>) {
    const { provider } = make(() => ({ status, json, ...(headers ? { headers } : {}) }))
    return provider.send('whatsapp:+573001112233', { kind: 'text', text: 'x' }).then(() => undefined, (e: unknown) => e)
  }

  it('429 → RateLimitedError honouring Retry-After', async () => {
    const err = await failWith(429, { code: 20429, message: 'Too Many Requests' }, { 'Retry-After': '7' })
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(7000)
  })

  it('21610 / 21211 → RecipientUnreachableError with the chat id', async () => {
    const err = await failWith(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' })
    expect(err).toBeInstanceOf(RecipientUnreachableError)
    expect((err as RecipientUnreachableError).chatId).toBe('whatsapp:+573001112233')
    expect(await failWith(400, { code: 21211, message: "Invalid 'To' Phone Number" })).toBeInstanceOf(RecipientUnreachableError)
  })

  it('63016 → OutsideSessionWindowError; 21617 → PayloadTooLargeError', async () => {
    expect(await failWith(400, { code: 63016, message: 'outside window' })).toBeInstanceOf(OutsideSessionWindowError)
    expect(await failWith(400, { code: 21617, message: 'body too long' })).toBeInstanceOf(PayloadTooLargeError)
  })

  it('anything else → TwilioApiError (a ProviderError) with status/code/moreInfo', async () => {
    const err = await failWith(401, { code: 20003, message: 'Authenticate', more_info: 'https://www.twilio.com/docs/errors/20003' })
    expect(err).toBeInstanceOf(TwilioApiError)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ status: 401, code: 20003, moreInfo: 'https://www.twilio.com/docs/errors/20003' })
  })
})

describe('TwilioProvider — media & typing', () => {
  afterEach(() => { vi.useRealTimers() })

  it('downloads Twilio media with Basic auth only on the API origin', async () => {
    const bytes = Buffer.from('JPEGDATA')
    const { provider, calls } = make(() => ({ bytes }))
    const got = await provider.downloadMedia({ kind: 'image', token: { url: WA_IMAGE.MediaUrl0 } })
    expect(got.equals(bytes)).toBe(true)
    expect(calls[0]!.headers.get('authorization')).toMatch(/^Basic /)
    await provider.downloadMedia({ kind: 'image', token: { url: 'https://cdn.example.com/a.jpg' } })
    expect(calls[1]!.headers.get('authorization')).toBeNull()
  })

  it('refuses private/unsafe media hosts (SSRF guard via secureFetch)', async () => {
    const { calls, http } = fakeHttp()
    const provider = new TwilioProvider({ accountSid: SID, authToken: TOKEN, webhookUrl: HOOK, http: { ...http, resolver: async () => ['10.0.0.5'] } })
    await expect(provider.downloadMedia({ kind: 'image', token: { url: 'https://evil.example.com/x' } })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('downloadMedia without a URL token rejects with ProviderError', async () => {
    const { provider } = make()
    await expect(provider.downloadMedia({ kind: 'image', token: undefined })).rejects.toBeInstanceOf(ProviderError)
  })

  it('typing posts the last inbound SID to Indicators/Typing (WhatsApp only)', async () => {
    const { provider, calls } = make(() => ({ json: { success: true } }))
    await provider.typing('whatsapp:+573001112233') // no inbound yet → no-op
    expect(calls).toHaveLength(0)
    const { body, headers } = signed(WA_TEXT)
    provider.ingest(body, headers)
    await provider.typing('whatsapp:+573001112233', 'typing')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://messaging.twilio.com/v3/Indicators/Typing.json')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.get('content-type')).toBe('application/json')
    expect(calls[0]!.headers.get('authorization')).toMatch(/^Basic /)
    // Exactly the documented v3 body: `channel` is the upper-case enum "WHATSAPP" (no extra fields).
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: 'WHATSAPP', messageId: WA_TEXT.MessageSid })
    await provider.typing('whatsapp:+573001112233', 'paused')
    await provider.typing('+15005550006')
    expect(calls).toHaveLength(1)
  })

  it('typing is never sent for SMS chats, even after an inbound SMS', async () => {
    const { provider, calls } = make(() => ({ json: { success: true } }))
    const { body, headers } = signed(SMS_TEXT)
    provider.ingest(body, headers)
    await provider.typing(SMS_TEXT.From, 'typing')
    await provider.typing(SMS_TEXT.From, 'recording')
    expect(calls).toHaveLength(0)
  })

  it('typing skips a message SID outside the documented SM/MM format', async () => {
    const { provider, calls } = make(() => ({ json: { success: true } }))
    const { body, headers } = signed({ ...WA_TEXT, MessageSid: 'SMshort', SmsMessageSid: 'SMshort', SmsSid: 'SMshort' })
    provider.ingest(body, headers)
    await provider.typing(WA_TEXT.From)
    expect(calls).toHaveLength(0)
  })

  it('typing degrades silently on a 4xx and stops retrying that chat for a while', async () => {
    let now = 1_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    const tick = (ms: number) => { now += ms; vi.setSystemTime(now) }
    vi.setSystemTime(now)
    const debug: unknown[] = []
    const logger = { trace() {}, debug: (o: unknown) => { debug.push(o) }, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger } }
    const { provider, calls } = make(
      () => ({ status: 400, json: { code: 20001, message: 'Request input may be invalid', status: 400 } }),
      { logger },
    )
    const { body, headers } = signed(WA_TEXT)
    provider.ingest(body, headers)
    await expect(provider.typing(WA_TEXT.From)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(debug).toContainEqual(expect.objectContaining({ chatId: WA_TEXT.From, status: 400 }))
    // Suppressed for this chat: no request at all while the backoff lasts…
    await provider.typing(WA_TEXT.From)
    tick(60_000)
    await provider.typing(WA_TEXT.From)
    expect(calls).toHaveLength(1)
    // …and retried once it expires.
    tick(60 * 60_000)
    await provider.typing(WA_TEXT.From)
    expect(calls).toHaveLength(2)
  })

  it('typing never rejects on 5xx / 429 / network errors (best-effort)', async () => {
    let status = 500
    const { provider, calls } = make(() => ({ status, json: { message: 'boom' } }))
    const { body, headers } = signed(WA_TEXT)
    provider.ingest(body, headers)
    await expect(provider.typing(WA_TEXT.From)).resolves.toBeUndefined()
    status = 429
    await expect(provider.typing(WA_TEXT.From)).resolves.toBeUndefined()
    expect(calls).toHaveLength(2) // transient failures do not suppress the chat

    const broken = new TwilioProvider({
      accountSid: SID, authToken: TOKEN, webhookUrl: HOOK,
      http: { fetch: (async () => { throw new Error('ECONNRESET') }) as typeof globalThis.fetch, resolver: async () => ['93.184.216.34'] },
    })
    const s = signed(WA_TEXT)
    broken.ingest(s.body, s.headers)
    await expect(broken.typing(WA_TEXT.From)).resolves.toBeUndefined()
  })

  it('typing skips an inbound older than the 24h customer-service window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const { provider, calls } = make(() => ({ json: { success: true } }))
    const { body, headers } = signed(WA_TEXT)
    provider.ingest(body, headers)
    vi.setSystemTime(1_000_000 + 24 * 60 * 60_000 + 1)
    await provider.typing(WA_TEXT.From)
    expect(calls).toHaveLength(0)
  })
})

describe('TwilioProvider — BSUID (business-scoped user id) chats', () => {
  it('keeps whatsapp:CO.xxx as a stable WhatsApp chat/sender id end-to-end', async () => {
    const { provider, calls, events } = make((c) => c.url.includes('Indicators')
      ? { json: { success: true } }
      : { status: 201, json: { sid: 'SMout', status: 'queued' } })
    const { body, headers } = signed(WA_BSUID_TEXT)
    expect(provider.ingest(body, headers)).toBe(200)
    const e = events.find((x) => x.kind === 'message')
    expect(e?.kind === 'message' && e.message).toMatchObject({
      chatId: 'whatsapp:CO.2132056440717202',
      senderId: 'whatsapp:CO.2132056440717202',
      chat: { kind: 'dm', platformData: { channel: 'whatsapp' } },
      senderInfo: { platformData: { channel: 'whatsapp', waId: 'CO.2132056440717202' } },
    })

    await provider.typing('whatsapp:CO.2132056440717202')
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: 'WHATSAPP', messageId: WA_BSUID_TEXT.MessageSid })

    await provider.send('whatsapp:CO.2132056440717202', { kind: 'text', text: 'hola' })
    const sent = parseFormParams(calls[1]!.body)
    expect(sent['To']).toBe('whatsapp:CO.2132056440717202')
    expect(sent['From']).toBe('whatsapp:+14155238886')
  })
})
