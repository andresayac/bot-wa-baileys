import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { OutsideSessionWindowError, RateLimitedError } from '@botmesh/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'

interface Call { url: string; init?: RequestInit }

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
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
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const baseCfg = { accessToken: 'TOK', phoneNumberId: 'PNID', verifyToken: 'vt', apiVersion: 'v21.0', graphUrl: 'https://graph.facebook.com', allowUnsignedWebhooks: true, mediaDownload: { resolver: async () => ['93.184.216.34'] } }

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('CloudAPIProvider', () => {
  it('requires signed webhooks unless local unsigned mode is explicit', () => {
    expect(() => new CloudAPIProvider({ ...baseCfg, allowUnsignedWebhooks: false })).toThrow(/appSecret/)
  })

  it('emits ready and closed lifecycle states in webhook mode', async () => {
    const p = new CloudAPIProvider(baseCfg)
    const states: string[] = []
    p.onEvent((event) => { if (event.kind === 'connection') states.push(event.update.state) })
    await p.start()
    await p.stop()
    expect(states).toEqual(['ready', 'closed'])
  })
  it('sends text to the Graph messages endpoint', async () => {
    const calls = mockFetch(() => ({ body: { messages: [{ id: 'wamid.OUT' }] } }))
    const p = new CloudAPIProvider(baseCfg)
    const res = await p.send('573001', { kind: 'text', text: 'hola' })
    expect(res.ref.id).toBe('wamid.OUT')
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/PNID/messages')
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.to).toBe('573001')
    expect(body.type).toBe('text')
    expect(body.text.body).toBe('hola')
  })

  it('uploads buffer media then sends with the media id', async () => {
    const calls = mockFetch((call) =>
      call.url.endsWith('/media') ? { body: { id: 'MEDIA_123' } } : { body: { messages: [{ id: 'wamid.IMG' }] } })
    const p = new CloudAPIProvider(baseCfg)
    const res = await p.send('573001', { kind: 'image', media: Buffer.from('x'), caption: 'c' })
    expect(res.ref.id).toBe('wamid.IMG')
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/PNID/media')
    const msgBody = JSON.parse(calls[1].init!.body as string)
    expect(msgBody.image.id).toBe('MEDIA_123')
  })

  it('uses a link for URL media (no upload)', async () => {
    const calls = mockFetch(() => ({ body: { messages: [{ id: 'w' }] } }))
    const p = new CloudAPIProvider(baseCfg)
    await p.send('573001', { kind: 'image', media: 'https://x/i.png' })
    expect(calls).toHaveLength(1) // only the message, no /media
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.image.link).toBe('https://x/i.png')
  })

  it('maps Graph 131047 to OutsideSessionWindowError', async () => {
    mockFetch(() => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement' } } }))
    const p = new CloudAPIProvider(baseCfg)
    await expect(p.send('573001', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(OutsideSessionWindowError)
  })

  it('maps Graph rate limit (code 4) to RateLimitedError with Retry-After', async () => {
    mockFetch(() => ({ status: 429, body: { error: { code: 4, message: 'rate' } }, headers: { 'Retry-After': '30' } }))
    const p = new CloudAPIProvider(baseCfg)
    await expect(p.send('573001', { kind: 'text', text: 'x' })).rejects.toMatchObject({ retryAfterMs: 30_000 })
  })

  it('verifyChallenge echoes the challenge on token match', () => {
    const p = new CloudAPIProvider(baseCfg)
    expect(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'CH' })).toBe('CH')
    expect(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'no', 'hub.challenge': 'CH' })).toBeNull()
  })

  it('ingest fans out normalized events', async () => {
    mockFetch(() => ({ body: {} }))
    const p = new CloudAPIProvider({ ...baseCfg, appSecret: undefined })
    const seen: string[] = []
    p.onEvent((e) => { if (e.kind === 'message') seen.push(e.message.body) })
    const code = p.ingest({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '573001', id: 'w', timestamp: '1', type: 'text', text: { body: 'hey' } }] } }] }],
    })
    expect(code).toBe(200)
    expect(seen).toEqual(['hey'])
  })

  it('ingest rejects a body with an invalid signature when appSecret is set', () => {
    const p = new CloudAPIProvider({ ...baseCfg, appSecret: 'shh' })
    let gotEvent = false
    p.onEvent(() => { gotEvent = true })
    const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: 'x', id: 'w', timestamp: '1', type: 'text', text: { body: 'evil' } }] } }] }] }
    const raw = JSON.stringify(body)
    // wrong signature
    expect(p.ingest(raw, { 'x-hub-signature-256': 'sha256=deadbeef' })).toBe(403)
    expect(gotEvent).toBe(false)
    // correct signature
    const good = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex')
    expect(p.ingest(raw, { 'x-hub-signature-256': good })).toBe(200)
    expect(gotEvent).toBe(true)
  })

  it('markRead posts a read status', async () => {
    const calls = mockFetch(() => ({ body: { success: true } }))
    const p = new CloudAPIProvider(baseCfg)
    await p.markRead([{ id: 'wamid.1', chatId: 'x' }])
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.status).toBe('read')
    expect(body.message_id).toBe('wamid.1')
  })
})
