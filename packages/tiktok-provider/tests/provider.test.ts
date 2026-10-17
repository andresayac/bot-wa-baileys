import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  OutsideSessionWindowError,
  PayloadTooLargeError,
  ProviderError,
  RateLimitedError,
  RecipientUnreachableError,
  UnsupportedContentError,
  type InboundEvent,
} from '@bot-wa/core'
import pino from 'pino'
import { TikTokProvider } from '../src/TikTokProvider.js'
import { TikTokApiError } from '../src/errors.js'
import type { TikTokProviderConfig } from '../src/types.js'
import * as fx from './fixtures/webhooks.js'

const SECRET = 'client-secret'

interface Call { url: string; init: RequestInit; json?: Record<string, unknown> }
type Responder = (call: Call) => Response | Promise<Response>

const ok = (data: unknown = {}) => new Response(JSON.stringify({ code: 0, message: 'OK', request_id: 'r', data }), { status: 200 })
const fail = (code: number, message: string, status = 200) => new Response(JSON.stringify({ code, message, request_id: 'r-err' }), { status })

function harness(responder: Responder = () => ok({ message: { message_id: 'sent-1' } }), extra: Partial<TikTokProviderConfig> = {}) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {} }
    if (typeof init?.body === 'string') call.json = JSON.parse(init.body) as Record<string, unknown>
    calls.push(call)
    return responder(call)
  })
  const provider = new TikTokProvider({
    accessToken: 'ACCESS',
    businessId: fx.BUSINESS_ID,
    appSecret: SECRET,
    logger: pino({ level: 'silent' }),
    http: { fetch: fetch as unknown as typeof globalThis.fetch, resolver: async () => ['93.184.216.34'] },
    ...extra,
  })
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  return { provider, calls, events, fetch }
}

const sign = (raw: string, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  ({ 'tiktok-signature': `t=${t},s=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}` })

describe('TikTokProvider — setup', () => {
  it('requires appSecret unless unsigned mode is explicit', () => {
    expect(() => new TikTokProvider({ accessToken: 'a', businessId: 'b' })).toThrow(/appSecret/)
    expect(() => new TikTokProvider({ accessToken: 'a', businessId: 'b', allowUnsignedWebhooks: true })).not.toThrow()
  })
  it('requires businessId', () => {
    expect(() => new TikTokProvider({ accessToken: 'a', businessId: '', appSecret: 's' })).toThrow(/businessId/)
  })
  it('exposes id, selfId and webhook capabilities', () => {
    const { provider } = harness()
    expect(provider.id).toBe('tiktok')
    expect(provider.selfId).toBe(fx.BUSINESS_ID)
    expect(provider.capabilities).toMatchObject({ pushIngress: true, buttons: true, groups: false, typing: true, readReceipts: true, reactions: false, polls: false, edit: false })
    expect(provider.capabilities.contentKinds).toEqual(['text', 'image', 'buttons', 'list', 'native'])
  })
  it('emits ready / closed lifecycle', async () => {
    const { provider, events } = harness()
    await provider.start()
    await provider.stop()
    expect(events.map((e) => e.kind === 'connection' && e.update.state)).toEqual(['ready', 'closed'])
  })
})

describe('TikTokProvider.ingest', () => {
  it('verifies the TikTok-Signature over the raw body and emits the comment', () => {
    const { provider, events } = harness()
    expect(provider.ingest(fx.commentInsertRaw, sign(fx.commentInsertRaw))).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'message', message: { chatId: 'comment:7203946942097902849:7247303576418566913', body: 'precio?' } })
  })
  it('accepts a Buffer body and a mixed-case header name', () => {
    const { provider, events } = harness()
    const raw = JSON.stringify(fx.dmText)
    const headers = { 'TikTok-Signature': sign(raw)['tiktok-signature'] }
    expect(provider.ingest(Buffer.from(raw), headers)).toBe(200)
    expect(events).toHaveLength(1)
  })
  it('rejects a forged / unsigned / stale body with 403 and emits nothing', () => {
    const { provider, events } = harness()
    const raw = JSON.stringify(fx.dmText)
    expect(provider.ingest(raw, sign(raw, undefined, 'wrong'))).toBe(403)
    expect(provider.ingest(raw, {})).toBe(403)
    expect(provider.ingest(raw, sign(raw, Math.floor(Date.now() / 1000) - 3600))).toBe(403)
    expect(events).toEqual([])
  })
  it('honours a custom signatureToleranceSec', () => {
    const { provider } = harness(undefined, { signatureToleranceSec: 7200 })
    const raw = JSON.stringify(fx.dmText)
    expect(provider.ingest(raw, sign(raw, Math.floor(Date.now() / 1000) - 3600))).toBe(200)
  })
  it('rejects a pre-parsed body when appSecret is set (signature needs raw bytes)', () => {
    const { provider } = harness()
    expect(provider.ingest(fx.dmText, sign(JSON.stringify(fx.dmText)))).toBe(400)
  })
  it('rejects invalid JSON with 400', () => {
    const { provider } = harness()
    expect(provider.ingest('{nope', sign('{nope'))).toBe(400)
  })
  it('accepts parsed bodies in explicit unsigned mode', () => {
    const { provider, events } = harness(undefined, { appSecret: undefined, allowUnsignedWebhooks: true })
    expect(provider.ingest(fx.dmText)).toBe(200)
    expect(events).toHaveLength(1)
  })
  it('ignores events for another TikTok account authorized on the same app', () => {
    const { provider, events } = harness()
    const raw = JSON.stringify({ ...fx.dmText, user_openid: 'someone-else' })
    expect(provider.ingest(raw, sign(raw))).toBe(200)
    expect(events).toEqual([])
  })
  it('does not let a throwing listener break ingest', () => {
    const { provider } = harness()
    provider.onEvent(() => { throw new Error('boom') })
    const raw = JSON.stringify(fx.dmText)
    expect(provider.ingest(raw, sign(raw))).toBe(200)
  })
})

describe('TikTokProvider.send — DMs', () => {
  it('POSTs /business/message/send/ with the Access-Token header', async () => {
    const { provider, calls } = harness()
    const res = await provider.send(`dm:${fx.CONVERSATION_ID}`, { kind: 'text', text: 'hola' })
    expect(res.ref).toEqual({ id: 'sent-1', chatId: `dm:${fx.CONVERSATION_ID}` })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://business-api.tiktok.com/open_api/v1.3/business/message/send/')
    expect(calls[0]!.init.method).toBe('POST')
    expect(new Headers(calls[0]!.init.headers).get('Access-Token')).toBe('ACCESS')
    expect(calls[0]!.json).toEqual({ business_id: fx.BUSINESS_ID, recipient_type: 'CONVERSATION', recipient: fx.CONVERSATION_ID, message_type: 'TEXT', text: { body: 'hola' } })
  })
  it('resolves an access-token function per request (token refresh)', async () => {
    let n = 0
    const { provider, calls } = harness(undefined, { accessToken: async () => `T${++n}` })
    await provider.send('dm:c', { kind: 'text', text: 'a' })
    await provider.send('dm:c', { kind: 'text', text: 'b' })
    expect(calls.map((c) => new Headers(c.init.headers).get('Access-Token'))).toEqual(['T1', 'T2'])
  })
  it('quotes the replied-to message', async () => {
    const { provider, calls } = harness()
    await provider.send('dm:c', { kind: 'text', text: 'a' }, { quoted: { id: 'm0', chatId: 'dm:c' } })
    expect(calls[0]!.json).toMatchObject({ referenced_message_info: { referenced_message_id: 'm0' } })
  })
  it('uploads a Buffer image then sends it by media_id', async () => {
    const { provider, calls } = harness((call) =>
      call.url.endsWith('/media/upload/') ? ok({ media_id: 'MID' }) : ok({ message: { message_id: 'img-1' } }))
    const res = await provider.send('dm:c', { kind: 'image', media: Buffer.from([1, 2, 3]) })
    expect(res.ref.id).toBe('img-1')
    expect(calls[0]!.url).toBe('https://business-api.tiktok.com/open_api/v1.3/business/message/media/upload/')
    const form = calls[0]!.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('business_id')).toBe(fx.BUSINESS_ID)
    expect(form.get('media_type')).toBe('IMAGE')
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect(calls[1]!.json).toMatchObject({ message_type: 'IMAGE', image: { media_id: 'MID' } })
  })
  it('sends an already-uploaded media_id without re-uploading', async () => {
    const { provider, calls } = harness()
    await provider.send('dm:c', { kind: 'image', media: { native: { mediaId: 'MID' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.json).toMatchObject({ image: { media_id: 'MID' } })
  })
  it('downloads a URL image through secureFetch before uploading it', async () => {
    const { provider, calls } = harness((call) => {
      if (call.url === 'https://cdn.example.com/a.png') return new Response(Buffer.from([9, 9]), { status: 200, headers: { 'content-type': 'image/png' } })
      if (call.url.endsWith('/media/upload/')) return ok({ media_id: 'MID2' })
      return ok({ message: { message_id: 'img-2' } })
    })
    await provider.send('dm:c', { kind: 'image', media: 'https://cdn.example.com/a.png' })
    expect(calls.map((c) => c.url)).toEqual([
      'https://cdn.example.com/a.png',
      'https://business-api.tiktok.com/open_api/v1.3/business/message/media/upload/',
      'https://business-api.tiktok.com/open_api/v1.3/business/message/send/',
    ])
    expect(new Headers(calls[0]!.init.headers).get('Access-Token')).toBeNull()
  })
  it('rejects SSRF-prone private image URLs', async () => {
    const { provider } = harness(undefined, { http: { resolver: async () => ['10.0.0.1'], fetch: (async () => ok()) as unknown as typeof globalThis.fetch } })
    await expect(provider.send('dm:c', { kind: 'image', media: 'https://intranet.local/a.png' })).rejects.toThrow()
  })
  it('sends a direct reply to a high-intent comment', async () => {
    const { provider, calls } = harness()
    await provider.send('hic:777', { kind: 'text', text: 'Te escribo por DM' })
    expect(calls[0]!.json).toEqual({
      business_id: fx.BUSINESS_ID,
      direct_reply: { reply_type: 'COMMENT_REPLY', comment_reply: { comment_id: '777' } },
      message_type: 'TEXT',
      text: { body: 'Te escribo por DM' },
    })
  })
  it('rejects unknown chat ids', async () => {
    const { provider } = harness()
    await expect(provider.send('comment:only-one-part', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RecipientUnreachableError)
  })
})

describe('TikTokProvider.send — comments', () => {
  it('replies to the thread via /business/comment/reply/create/', async () => {
    const { provider, calls } = harness(() => ok({ comment_id: '9001', video_id: '111' }))
    const res = await provider.send('comment:111:222', { kind: 'text', text: 'Gracias!' })
    expect(calls[0]!.url).toBe('https://business-api.tiktok.com/open_api/v1.3/business/comment/reply/create/')
    expect(calls[0]!.json).toEqual({ business_id: fx.BUSINESS_ID, video_id: '111', comment_id: '222', text: 'Gracias!' })
    expect(res.ref).toEqual({ id: '9001', chatId: 'comment:111:222' })
  })
  it('drops the comment.update echo of its own reply (no reply loops)', async () => {
    const { provider, events } = harness(() => ok({ comment_id: '7247303576418566999' }))
    await provider.send('comment:7203946942097902849:7235861947622916866', { kind: 'text', text: 'yo' })
    provider.ingest(fx.commentReplyInsertRaw, sign(fx.commentReplyInsertRaw))
    expect(events.filter((e) => e.kind === 'message')).toEqual([])
  })
  it('rejects too-long comment replies before calling the API', async () => {
    const { provider, calls } = harness()
    await expect(provider.send('comment:1:2', { kind: 'text', text: 'x'.repeat(151) })).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(calls).toEqual([])
  })
  it('rejects media on comments', async () => {
    const { provider } = harness()
    await expect(provider.send('comment:1:2', { kind: 'image', media: Buffer.alloc(1) })).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})

describe('TikTokProvider — error mapping', () => {
  it.each([
    [fail(40100, 'Requests made too frequently.'), RateLimitedError],
    [fail(40016, 'Requests made too frequently.'), RateLimitedError],
    [new Response('busy', { status: 429, headers: { 'retry-after': '7' } }), RateLimitedError],
    [fail(40002, 'You can only send 10 messages within 48 hours after the user message'), OutsideSessionWindowError],
    [fail(40007, 'The conversation does not exist.'), RecipientUnreachableError],
    [fail(40105, 'Invalid or incorrect access token.'), TikTokApiError],
    [new Response('<html>oops</html>', { status: 502 }), TikTokApiError],
  ])('maps a failing response to a typed ProviderError (%#)', async (response, Type) => {
    const { provider } = harness(() => response)
    const err = await provider.send('dm:c', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Type)
    expect(err).toBeInstanceOf(ProviderError)
  })
  it('carries the TikTok code and request_id on TikTokApiError', async () => {
    const { provider } = harness(() => fail(40105, 'Invalid or incorrect access token.'))
    const err = await provider.send('dm:c', { kind: 'text', text: 'x' }).catch((e: unknown) => e) as TikTokApiError
    expect(err.code).toBe(40105)
    expect(err.requestId).toBe('r-err')
  })
  it('honours Retry-After on HTTP 429', async () => {
    const { provider } = harness(() => new Response('busy', { status: 429, headers: { 'retry-after': '7' } }))
    const err = await provider.send('dm:c', { kind: 'text', text: 'x' }).catch((e: unknown) => e) as RateLimitedError
    expect(err.retryAfterMs).toBe(7000)
  })
})

describe('TikTokProvider — actions', () => {
  it('typing sends a TYPING sender action on DMs and is a no-op on comments', async () => {
    const { provider, calls } = harness()
    await provider.typing('dm:c', 'typing')
    await provider.typing('comment:1:2')
    await provider.typing('dm:c', 'paused')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.json).toEqual({ business_id: fx.BUSINESS_ID, recipient_type: 'CONVERSATION', recipient: 'c', message_type: 'SENDER_ACTION', sender_action: 'TYPING' })
  })
  it('markRead sends one MARK_READ per DM conversation', async () => {
    const { provider, calls } = harness()
    await provider.markRead([{ id: '1', chatId: 'dm:a' }, { id: '2', chatId: 'dm:a' }, { id: '3', chatId: 'dm:b' }, { id: '4', chatId: 'comment:1:2' }])
    expect(calls.map((c) => [c.json?.recipient, c.json?.sender_action])).toEqual([['a', 'MARK_READ'], ['b', 'MARK_READ']])
  })
  it('downloads DM media: resolves download_url, then fetches it via secureFetch', async () => {
    const { provider, calls } = harness((call) => {
      if (call.url.endsWith('/media/download/')) return ok({ download_url: 'https://media.tiktokcdn.com/x.jpg' })
      return new Response(Buffer.from([1, 2, 3]), { status: 200 })
    })
    const buf = await provider.downloadMedia({ kind: 'image', token: { mediaId: 'M', messageId: 'MSG', conversationId: 'C', mediaType: 'IMAGE' } })
    expect(Buffer.from(buf as Buffer)).toEqual(Buffer.from([1, 2, 3]))
    expect(calls[0]!.json).toEqual({ business_id: fx.BUSINESS_ID, conversation_id: 'C', message_id: 'MSG', media_id: 'M', media_type: 'IMAGE' })
    expect(calls[1]!.url).toBe('https://media.tiktokcdn.com/x.jpg')
    expect(new Headers(calls[1]!.init.headers).get('Access-Token')).toBeNull()
  })
  it('downloads URL media (stickers) directly', async () => {
    const { provider, calls } = harness(() => new Response(Buffer.from([7]), { status: 200 }))
    await provider.downloadMedia({ kind: 'sticker', token: { url: 'https://p16-sign.tiktokcdn.com/s.webp' } })
    expect(calls.map((c) => c.url)).toEqual(['https://p16-sign.tiktokcdn.com/s.webp'])
  })
  it('rejects a media ref it did not produce', async () => {
    const { provider } = harness()
    await expect(provider.downloadMedia({ kind: 'image', token: 42 })).rejects.toBeInstanceOf(ProviderError)
  })
})
