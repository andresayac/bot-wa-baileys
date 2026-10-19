/**
 * Webhook robustness + inbound edge cases + outbound media typing for the
 * Cloud API transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { ProviderError } from '@bot-wa/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'
import { parseInbound, type GraphWebhookBody } from '../src/parseInbound.js'

const wrap = (value: unknown): GraphWebhookBody => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'pnid', changes: [{ field: 'messages', value: value as never }] }],
})

const baseCfg = { accessToken: 'TOK', phoneNumberId: 'PNID', verifyToken: 'vt', allowUnsignedWebhooks: true }

interface Call { url: string; init?: RequestInit }
function mockFetch(responder: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const r = responder(call)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: () => null }, json: async () => r.body ?? {} }
  }))
  return calls
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('CloudAPIProvider.ingest — malformed bodies', () => {
  it('answers 400 (never throws) for a raw body that is not JSON', () => {
    const p = new CloudAPIProvider(baseCfg)
    expect(p.ingest('{not json')).toBe(400)
    expect(p.ingest(Buffer.from('<html>'))).toBe(400)
  })

  it('answers 400 for a correctly signed body that is not JSON', () => {
    const p = new CloudAPIProvider({ ...baseCfg, appSecret: 'shh' })
    const raw = '{oops'
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex')
    expect(p.ingest(raw, { 'x-hub-signature-256': sig })).toBe(400)
  })

  it('accepts a Uint8Array raw body (e.g. a fetch-style request) with a valid signature', () => {
    const p = new CloudAPIProvider({ ...baseCfg, appSecret: 'shh' })
    const raw = JSON.stringify(wrap({ messages: [{ from: '573001', id: 'w', timestamp: '1', type: 'text', text: { body: 'hey' } }] }))
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex')
    const seen: string[] = []
    p.onEvent((e) => { if (e.kind === 'message') seen.push(e.message.body) })
    expect(p.ingest(new Uint8Array(Buffer.from(raw)), { 'x-hub-signature-256': sig })).toBe(200)
    expect(seen).toEqual(['hey'])
  })
})

describe('parseInbound — edge cases', () => {
  it('maps a template quick-reply button (type "button") to a button interaction', () => {
    const [e] = parseInbound(wrap({
      messages: [{ from: '573001', id: 'wamid.B', timestamp: '5', type: 'button', button: { payload: 'YES_PAYLOAD', text: 'Yes' } }],
    }))
    expect(e?.kind).toBe('interaction')
    if (e?.kind === 'interaction') {
      expect(e.interaction.kind).toBe('button')
      expect(e.interaction.data).toBe('YES_PAYLOAD')
      expect(e.interaction.interactionId).toBe('wamid.B')
    }
  })

  it('exposes the replied-to message as quoted.ref', () => {
    const [e] = parseInbound(wrap({
      messages: [{ from: '573001', id: 'wamid.R', timestamp: '5', type: 'text', text: { body: 'yes' }, context: { from: '15550001', id: 'wamid.ORIG' } }],
    }))
    expect(e?.kind).toBe('message')
    if (e?.kind === 'message') expect(e.message.quoted?.ref).toMatchObject({ id: 'wamid.ORIG', chatId: '573001' })
  })

  it('drops statuses it does not know instead of reporting them as failed', () => {
    const events = parseInbound(wrap({
      statuses: [
        { id: 'wamid.S1', recipient_id: '573001', status: 'deleted', timestamp: '1' },
        { id: 'wamid.S2', recipient_id: '573001', status: 'warning', timestamp: '1' },
        { id: 'wamid.S3', recipient_id: '573001', status: 'delivered', timestamp: '1' },
      ],
    }))
    expect(events.map((e) => (e.kind === 'status' ? `${e.status.ref.id}:${e.status.status}` : e.kind))).toEqual(['wamid.S3:delivered'])
  })

  it('gives location and contact messages a readable body', () => {
    const events = parseInbound(wrap({
      messages: [
        { from: '573001', id: 'wamid.L', timestamp: '1', type: 'location', location: { latitude: 1, longitude: 2, name: 'Office', address: 'Main St' } },
        { from: '573001', id: 'wamid.C', timestamp: '1', type: 'contacts', contacts: [{ name: { formatted_name: 'Ana' } }] },
      ],
    }))
    const bodies = events.map((e) => (e.kind === 'message' ? e.message.body : ''))
    expect(bodies).toEqual(['Office, Main St', 'Ana'])
  })

  it('exposes the coordinates of a location message on message.location', () => {
    const events = parseInbound(wrap({
      messages: [
        { from: '573001', id: 'wamid.L', timestamp: '1', type: 'location', location: { latitude: 4.6, longitude: -74.1, name: 'Office', address: 'Main St' } },
        { from: '573001', id: 'wamid.L2', timestamp: '1', type: 'location', location: { latitude: 4.6 } },
      ],
    }))
    const locations = events.map((e) => (e.kind === 'message' ? e.message.location : null))
    expect(locations).toEqual([{ latitude: 4.6, longitude: -74.1, name: 'Office', address: 'Main St' }, undefined])
  })
})

describe('CloudAPIProvider.send — media upload typing', () => {
  const uploadType = (call: Call): string => ((call.init!.body as FormData).get('type') as string)

  it('uploads a Buffer image with an image MIME type, not application/octet-stream', async () => {
    const calls = mockFetch((c) => (c.url.endsWith('/media') ? { body: { id: 'M' } } : { body: { messages: [{ id: 'w' }] } }))
    const p = new CloudAPIProvider(baseCfg)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    await p.send('573001', { kind: 'image', media: png })
    expect(uploadType(calls[0]!)).toBe('image/png')
  })

  it('falls back to the kind default when the bytes are not recognised', async () => {
    const calls = mockFetch((c) => (c.url.endsWith('/media') ? { body: { id: 'M' } } : { body: { messages: [{ id: 'w' }] } }))
    const p = new CloudAPIProvider(baseCfg)
    await p.send('573001', { kind: 'voice', media: Buffer.from('x') })
    expect(uploadType(calls[0]!)).toBe('audio/ogg')
  })

  it('uses a document mimetype and filename as given', async () => {
    const calls = mockFetch((c) => (c.url.endsWith('/media') ? { body: { id: 'M' } } : { body: { messages: [{ id: 'w' }] } }))
    const p = new CloudAPIProvider(baseCfg)
    await p.send('573001', { kind: 'document', media: Buffer.from('x'), mimetype: 'text/csv', filename: 'r.csv' })
    expect(uploadType(calls[0]!)).toBe('text/csv')
    expect(((calls[0]!.init!.body as FormData).get('file') as File).name).toBe('r.csv')
  })
})

describe('GraphClient — network failures', () => {
  it('rejects a send with a typed ProviderError when fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const p = new CloudAPIProvider(baseCfg)
    await expect(p.send('573001', { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('CloudAPIProvider send errors carry the content kind', () => {
  it('131051 reports the kind that was sent (not the generic fallback)', async () => {
    mockFetch(() => ({ status: 400, body: { error: { code: 131051, message: 'Unsupported message type' } } }))
    const err = await new CloudAPIProvider(baseCfg).send('573001', { kind: 'location', lat: 1, lng: 2 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'UnsupportedContentError', kind: 'location' })
  })

  it('131062 reports the kind that was sent', async () => {
    mockFetch(() => ({ status: 400, body: { error: { code: 131062, message: 'BSUID not supported' } } }))
    const err = await new CloudAPIProvider(baseCfg).send('US.1349', { kind: 'text', text: 'hi' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'UnsupportedContentError', kind: 'text' })
  })
})
