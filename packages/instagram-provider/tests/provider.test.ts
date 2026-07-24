import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { RateLimitedError, UnsupportedContentError } from '@bot-wa/core'
import { InstagramProvider } from '../src/InstagramProvider.js'

interface Call { url: string; init?: RequestInit }

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string>; bytes?: Uint8Array }) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const r = responder(call)
    const bytes = r.bytes
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k] ?? null },
      json: async () => r.body ?? {},
      arrayBuffer: async () =>
        bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0),
    }
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const baseCfg = { accessToken: 'TOK', verifyToken: 'vt', apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', allowUnsignedWebhooks: true, mediaDownload: { resolver: async () => ['93.184.216.34'] } }

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('InstagramProvider', () => {
  it('requires signed webhooks unless local unsigned mode is explicit', () => {
    expect(() => new InstagramProvider({ ...baseCfg, allowUnsignedWebhooks: false })).toThrow(/appSecret/)
  })

  it('emits ready and closed lifecycle states in webhook mode', async () => {
    const p = new InstagramProvider(baseCfg)
    const states: string[] = []
    p.onEvent((event) => { if (event.kind === 'connection') states.push(event.update.state) })
    await p.start()
    await p.stop()
    expect(states).toEqual(['ready', 'closed'])
  })
  it('sends text to me/messages with recipient.id', async () => {
    const calls = mockFetch(() => ({ body: { recipient_id: 'IGSID_1', message_id: 'mid.OUT' } }))
    const p = new InstagramProvider(baseCfg)
    const res = await p.send('IGSID_1', { kind: 'text', text: 'hola' })
    expect(res.ref.id).toBe('mid.OUT')
    expect(res.ref.chatId).toBe('IGSID_1')
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/me/messages')
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.recipient.id).toBe('IGSID_1')
    expect(body.message.text).toBe('hola')
    const headers = calls[0].init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer TOK')
  })

  it('sends image URL media as an attachment', async () => {
    const calls = mockFetch(() => ({ body: { message_id: 'mid.IMG' } }))
    const p = new InstagramProvider(baseCfg)
    await p.send('IGSID_1', { kind: 'image', media: 'https://x/i.png' })
    expect(calls).toHaveLength(1) // URL-only: no upload step
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.message.attachment.type).toBe('image')
    expect(body.message.attachment.payload.url).toBe('https://x/i.png')
  })

  it('rejects buffer media with UnsupportedContentError (no network call)', async () => {
    const calls = mockFetch(() => ({ body: {} }))
    const p = new InstagramProvider(baseCfg)
    await expect(p.send('IGSID_1', { kind: 'image', media: Buffer.from('x') })).rejects.toBeInstanceOf(UnsupportedContentError)
    expect(calls).toHaveLength(0)
  })

  it('typing sends sender_action typing_on / typing_off', async () => {
    const calls = mockFetch(() => ({ body: { recipient_id: 'IGSID_1' } }))
    const p = new InstagramProvider(baseCfg)
    await p.typing('IGSID_1')
    await p.typing('IGSID_1', 'paused')
    expect(JSON.parse(calls[0].init!.body as string).sender_action).toBe('typing_on')
    expect(JSON.parse(calls[1].init!.body as string).sender_action).toBe('typing_off')
  })

  it('markRead posts sender_action mark_seen (deduped per chat)', async () => {
    const calls = mockFetch(() => ({ body: {} }))
    const p = new InstagramProvider(baseCfg)
    await p.markRead([{ id: 'mid.1', chatId: 'IGSID_1' }, { id: 'mid.2', chatId: 'IGSID_1' }])
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.sender_action).toBe('mark_seen')
    expect(body.recipient.id).toBe('IGSID_1')
  })

  it('maps Graph rate limit (code 4) to RateLimitedError with Retry-After', async () => {
    mockFetch(() => ({ status: 429, body: { error: { code: 4, message: 'rate' } }, headers: { 'Retry-After': '30' } }))
    const p = new InstagramProvider(baseCfg)
    await expect(p.send('IGSID_1', { kind: 'text', text: 'x' })).rejects.toMatchObject({ retryAfterMs: 30_000 })
    await expect(p.send('IGSID_1', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('verifyChallenge echoes the challenge on token match', () => {
    const p = new InstagramProvider(baseCfg)
    expect(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'CH' })).toBe('CH')
    expect(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'no', 'hub.challenge': 'CH' })).toBeNull()
  })

  it('ingest fans out normalized events and returns 200', () => {
    const p = new InstagramProvider(baseCfg)
    const seen: string[] = []
    p.onEvent((e) => { if (e.kind === 'message') seen.push(e.message.body) })
    const code = p.ingest({
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, recipient: { id: 'P' }, timestamp: 1, message: { mid: 'm', text: 'hey' } }] }],
    })
    expect(code).toBe(200)
    expect(seen).toEqual(['hey'])
  })

  it('ingest skips echoes and rejects a body with an invalid signature when appSecret is set', () => {
    const p = new InstagramProvider({ ...baseCfg, appSecret: 'shh' })
    let gotEvent = false
    p.onEvent(() => { gotEvent = true })
    const body = {
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, recipient: { id: 'P' }, timestamp: 1, message: { mid: 'm', text: 'evil' } }] }],
    }
    const raw = JSON.stringify(body)
    // wrong signature
    expect(p.ingest(raw, { 'x-hub-signature-256': 'sha256=deadbeef' })).toBe(403)
    expect(gotEvent).toBe(false)
    // correct signature
    const good = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex')
    expect(p.ingest(raw, { 'x-hub-signature-256': good })).toBe(200)
    expect(gotEvent).toBe(true)
  })

  it('downloadMedia fetches the MediaRef.token URL', async () => {
    // downloadMedia uses the hardened secureFetch (real undici, IP-pinned), so it
    // hits a real loopback server; pin to 127.0.0.1 via mediaDownload.
    const server = createServer((_req, res) => { res.statusCode = 200; res.end(Buffer.from([1, 2, 3])) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const p = new InstagramProvider({ ...baseCfg, mediaDownload: { allowHttp: true, allowPrivateHosts: true, resolver: async () => ['127.0.0.1'] } })
      const out = await p.downloadMedia({ kind: 'image', token: `http://127.0.0.1:${port}/x.jpg` })
      expect(Buffer.isBuffer(out)).toBe(true)
      expect(Buffer.from(out as Buffer)).toEqual(Buffer.from([1, 2, 3]))
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('capabilities advertise IG DM limits', () => {
    const p = new InstagramProvider(baseCfg)
    expect(p.id).toBe('instagram')
    expect(p.capabilities).toMatchObject({
      pushIngress: true, buttons: true, lists: false, polls: false, reactions: false,
      edit: false, typing: true, presence: false, readReceipts: true, groups: false,
      templates: false, interactionsRequireAck: false,
    })
  })
})
