import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { ProviderError, RateLimitedError, UnsupportedContentError } from '@bot-wa/core'
import type { IProvider } from '@bot-wa/core'
import { MessengerProvider } from '../src/MessengerProvider.js'

interface Call { url: string; init?: RequestInit }

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string>; bytes?: Buffer }) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const r = responder(call)
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k] ?? null },
      json: async () => r.body ?? {},
      arrayBuffer: async () => {
        const src = r.bytes ?? Buffer.alloc(0)
        return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)
      },
    }
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const baseCfg = { accessToken: 'TOK', verifyToken: 'vt', apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', pageId: 'me', allowUnsignedWebhooks: true, mediaDownload: { resolver: async () => ['93.184.216.34'] } }

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('MessengerProvider', () => {
  it('requires signed webhooks unless local unsigned mode is explicit', () => {
    expect(() => new MessengerProvider({ ...baseCfg, allowUnsignedWebhooks: false })).toThrow(/appSecret/)
  })

  it('emits ready and closed lifecycle states in webhook mode', async () => {
    const p = new MessengerProvider(baseCfg)
    const states: string[] = []
    p.onEvent((event) => { if (event.kind === 'connection') states.push(event.update.state) })
    await p.start()
    await p.stop()
    expect(states).toEqual(['ready', 'closed'])
  })
  it('exposes id and webhook capabilities', () => {
    const p = new MessengerProvider(baseCfg)
    expect(p.id).toBe('messenger')
    expect(p.capabilities.pushIngress).toBe(true)
    expect(p.capabilities.buttons).toBe(true)
    expect(p.capabilities.lists).toBe(true)
    expect(p.capabilities.typing).toBe(true)
    expect(p.capabilities.readReceipts).toBe(true)
    expect(p.capabilities.polls).toBe(false)
    expect(p.capabilities.groups).toBe(false)
    expect(p.capabilities.interactionsRequireAck).toBe(false)
  })

  it('sends text to the Send API with RESPONSE messaging_type', async () => {
    const calls = mockFetch(() => ({ body: { recipient_id: 'USER1', message_id: 'mid.OUT' } }))
    const p = new MessengerProvider(baseCfg)
    const res = await p.send('USER1', { kind: 'text', text: 'hola' })
    expect(res.ref.id).toBe('mid.OUT')
    expect(res.ref.chatId).toBe('USER1')
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/me/messages')
    const headers = calls[0].init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer TOK')
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.recipient).toEqual({ id: 'USER1' })
    expect(body.messaging_type).toBe('RESPONSE')
    expect(body.message).toEqual({ text: 'hola' })
  })

  it('honors a custom pageId', async () => {
    const calls = mockFetch(() => ({ body: { message_id: 'm' } }))
    const p = new MessengerProvider({ ...baseCfg, pageId: '1234567890' })
    await p.send('U', { kind: 'text', text: 'x' })
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890/messages')
  })

  it('sends buttons as a button template', async () => {
    const calls = mockFetch(() => ({ body: { message_id: 'm' } }))
    const p = new MessengerProvider(baseCfg)
    await p.send('U', { kind: 'buttons', text: 'Pick', buttons: [{ id: 'YES', title: 'Yes' }, { id: 'NO', title: 'No' }] })
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.message.attachment.type).toBe('template')
    expect(body.message.attachment.payload.template_type).toBe('button')
    expect(body.message.attachment.payload.buttons).toEqual([
      { type: 'postback', title: 'Yes', payload: 'YES' },
      { type: 'postback', title: 'No', payload: 'NO' },
    ])
  })

  it('sends URL media as a reusable attachment (single call, no upload)', async () => {
    const calls = mockFetch(() => ({ body: { message_id: 'm' } }))
    const p = new MessengerProvider(baseCfg)
    await p.send('U', { kind: 'image', media: 'https://x/i.png' })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.message.attachment).toEqual({ type: 'image', payload: { url: 'https://x/i.png', is_reusable: true } })
  })

  it('rejects non-URL media with UnsupportedContentError', async () => {
    mockFetch(() => ({ body: {} }))
    const p = new MessengerProvider(baseCfg)
    await expect(p.send('U', { kind: 'image', media: Buffer.from('bytes') })).rejects.toBeInstanceOf(UnsupportedContentError)
    await expect(p.send('U', { kind: 'video', media: { path: '/tmp/v.mp4' } })).rejects.toThrow(/public URL/)
  })

  it('typing sends sender_action typing_on / typing_off (no message key)', async () => {
    const calls = mockFetch(() => ({ body: { recipient_id: 'U' } }))
    const p = new MessengerProvider(baseCfg)
    await p.typing('U')
    await p.typing('U', 'paused')
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ recipient: { id: 'U' }, sender_action: 'typing_on' })
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ recipient: { id: 'U' }, sender_action: 'typing_off' })
  })

  it('markRead sends mark_seen once per chat', async () => {
    const calls = mockFetch(() => ({ body: {} }))
    const p = new MessengerProvider(baseCfg)
    await p.markRead([{ id: 'm1', chatId: 'U' }, { id: 'm2', chatId: 'U' }, { id: 'm3', chatId: 'V' }])
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ recipient: { id: 'U' }, sender_action: 'mark_seen' })
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ recipient: { id: 'V' }, sender_action: 'mark_seen' })
  })

  it('acknowledgeInteraction is a safe no-op', async () => {
    // Call through the IProvider contract (the concrete no-op takes no args).
    const p: IProvider = new MessengerProvider(baseCfg)
    expect(p.acknowledgeInteraction).toBeTypeOf('function')
    await expect(p.acknowledgeInteraction?.('i-1')).resolves.toBeUndefined()
  })

  it('downloadMedia fetches the attachment URL into a Buffer', async () => {
    // downloadMedia uses the hardened secureFetch (real undici, IP-pinned), so it
    // hits a real loopback server; pin to 127.0.0.1 via mediaDownload.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const server = createServer((_req, res) => { res.statusCode = 200; res.end(png) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const p = new MessengerProvider({ ...baseCfg, mediaDownload: { allowHttp: true, allowPrivateHosts: true, resolver: async () => ['127.0.0.1'] } })
      const buf = await p.downloadMedia({ kind: 'image', token: `http://127.0.0.1:${port}/img.png` })
      expect(Buffer.compare(buf as Buffer, png)).toBe(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('maps Graph rate limits (code 4) to RateLimitedError with Retry-After', async () => {
    mockFetch(() => ({ status: 429, body: { error: { code: 4, message: 'rate' } }, headers: { 'Retry-After': '30' } }))
    const p = new MessengerProvider(baseCfg)
    await expect(p.send('U', { kind: 'text', text: 'x' })).rejects.toMatchObject({ name: 'RateLimitedError', retryAfterMs: 30_000 })
  })

  it('maps other Graph errors to ProviderError', async () => {
    mockFetch(() => ({ status: 400, body: { error: { code: 100, message: 'Invalid param' } } }))
    const p = new MessengerProvider(baseCfg)
    await expect(p.send('U', { kind: 'text', text: 'x' })).rejects.toThrow(ProviderError)
    await expect(p.send('U', { kind: 'text', text: 'x' })).rejects.toThrow(/Invalid param \(code 100\)/)
  })

  it('verifyChallenge echoes the challenge on token match', () => {
    const p = new MessengerProvider(baseCfg)
    expect(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'CH' })).toBe('CH')
    expect(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'no', 'hub.challenge': 'CH' })).toBeNull()
  })

  it('ingest fans out normalized events and returns 200', () => {
    const p = new MessengerProvider(baseCfg)
    const seen: string[] = []
    p.onEvent((e) => { if (e.kind === 'message') seen.push(e.message.body) })
    const code = p.ingest({
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'U' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'm', text: 'hey' } }] }],
    })
    expect(code).toBe(200)
    expect(seen).toEqual(['hey'])
  })

  it('ingest rejects a forged body when appSecret is set', () => {
    const p = new MessengerProvider({ ...baseCfg, appSecret: 'shh' })
    let gotEvent = false
    p.onEvent(() => { gotEvent = true })
    const body = { object: 'page', entry: [{ messaging: [{ sender: { id: 'U' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'm', text: 'evil' } }] }] }
    const raw = JSON.stringify(body)
    // wrong signature
    expect(p.ingest(raw, { 'x-hub-signature-256': 'sha256=deadbeef' })).toBe(403)
    expect(gotEvent).toBe(false)
    // correct signature
    const good = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex')
    expect(p.ingest(raw, { 'x-hub-signature-256': good })).toBe(200)
    expect(gotEvent).toBe(true)
  })
})
