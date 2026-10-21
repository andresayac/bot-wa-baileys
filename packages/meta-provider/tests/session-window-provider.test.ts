import { Readable } from 'node:stream'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DeliveryStatus, InboundEvent } from '@botmesh/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'
import { SessionWindowManager, SessionWindowReopenedError, type SessionReport, type SessionWindowState } from '../src/sessionWindow.js'
import { UsageTracker } from '../src/pricing.js'
import { rawFixture } from './support-fixtures.js'

interface Call { url: string; body: Record<string, unknown> }

/**
 * Fake Graph: free-form messages to `closed` recipients fail with 131047.
 * Media uploads (`/media`) are recorded in `uploads` with their byte size.
 */
function mockGraph(closed: Set<string>, uploads: Array<{ url: string; size: number }> = []) {
  const calls: Call[] = []
  let n = 0
  let m = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/media')) {
      const file = (init?.body as FormData).get('file') as Blob
      uploads.push({ url, size: file.size })
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: `MEDIA${++m}` }) }
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url, body })
    const fail = body.type !== 'template' && closed.has(String(body.to))
    const payload = fail
      ? { error: { code: 131047, message: 'Re-engagement message' } }
      : { messages: [{ id: `wamid.OUT${++n}` }] }
    return {
      ok: !fail,
      status: fail ? 400 : 200,
      headers: { get: () => null },
      json: async () => payload,
    }
  }))
  return calls
}

const baseCfg = { accessToken: 'TOK', phoneNumberId: 'PNID', verifyToken: 'vt', allowUnsignedWebhooks: true }
const USER = '573001112233'
const TEMPLATE = { kind: 'template', name: 'reopen_chat', language: 'es' } as const

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('CloudAPIProvider: session window', () => {
  it('without sessionWindow, behaves as before (OutsideSessionWindowError, no template)', async () => {
    const calls = mockGraph(new Set([USER]))
    const p = new CloudAPIProvider(baseCfg)
    expect(p.sessionWindow).toBeUndefined()
    await expect(p.send(USER, { kind: 'text', text: 'x' })).rejects.toThrow(/131047/)
    expect(calls).toHaveLength(1)
  })

  it('reopens with the template on 131047 and delivers the queued message when the user replies', async () => {
    const closed = new Set([USER])
    const calls = mockGraph(closed)
    const reports: SessionReport[] = []
    // Clock just before the fixture's inbound timestamp (1751400300 s).
    const now = (): number => 1751400290_000
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE, now, onReport: (r) => reports.push(r) } })

    await expect(p.send(USER, { kind: 'text', text: 'tu pedido llegó' })).rejects.toBeInstanceOf(SessionWindowReopenedError)
    expect(calls.map((c) => c.body.type)).toEqual(['text', 'template'])
    expect(calls[1].body).toMatchObject({ to: USER, template: { name: 'reopen_chat', language: { code: 'es' } } })
    expect(p.sessionWindow!.pending(USER)).toBe(1)

    // User replies (webhook) → window opens → queued text is retried.
    closed.delete(USER)
    const seen: InboundEvent[] = []
    p.onEvent((e) => { seen.push(e) })
    expect(p.ingest(rawFixture('message-text'))).toBe(200)
    await flush()
    expect(seen.map((e) => e.kind)).toEqual(['message'])
    expect(calls.at(-1)!.body).toMatchObject({ to: USER, type: 'text', text: { body: 'tu pedido llegó' } })
    expect(reports.map((r) => r.outcome)).toEqual(['queued', 'sent'])
    expect(await p.sessionWindow!.isOpen(USER)).toBe(true)
  })

  it('tracks inbound time from webhooks and skips the doomed send once known closed', async () => {
    const calls = mockGraph(new Set())
    let clock = 1751400300_000 // message-text fixture timestamp
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE, now: () => clock } })
    p.ingest(rawFixture('message-text'))
    await flush()
    expect(await p.sessionWindow!.expiresAt(USER)).toBe(1751400300_000 + 24 * 3_600_000)
    clock += 25 * 3_600_000
    await expect(p.send(USER, { kind: 'text', text: 'x' })).rejects.toBeInstanceOf(SessionWindowReopenedError)
    expect(calls.map((c) => c.body.type)).toEqual(['template'])
  })

  it('reacts to an async 131047 failed status for a message it sent', async () => {
    const calls = mockGraph(new Set())
    const reports: SessionReport[] = []
    const manager = new SessionWindowManager({ reopenTemplate: TEMPLATE, onReport: (r) => reports.push(r) })
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: manager })
    // A shared manager is scoped to the provider's business number.
    expect(p.sessionWindow).toBe(manager.forScope('PNID'))
    // Graph accepted the message synchronously (id wamid.OUT1)...
    const res = await p.send(USER, { kind: 'text', text: 'late' })
    // ...then the status webhook says it failed with 131047.
    const failed = rawFixture('status-failed-131047').replace('wamid.LATE', res.ref.id)
    p.ingest(failed)
    await flush()
    expect(calls.map((c) => c.body.type)).toEqual(['text', 'template'])
    expect(reports.at(-1)).toMatchObject({ outcome: 'queued', reason: 'status', chatId: USER })
  })
})

describe('CloudAPIProvider: session window media retries', () => {
  const streamOf = (...chunks: string[]): NodeJS.ReadableStream => Readable.from(chunks.map((c) => Buffer.from(c)))

  it('a stream media send that hits 131047 is retried on reply with the same uploaded media', async () => {
    const closed = new Set([USER])
    const uploads: Array<{ url: string; size: number }> = []
    const calls = mockGraph(closed, uploads)
    const reports: SessionReport[] = []
    const now = (): number => 1751400290_000
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE, now, onReport: (r) => reports.push(r) } })

    await expect(p.send(USER, { kind: 'image', media: { stream: streamOf('abc', 'def') }, caption: 'pic' }))
      .rejects.toBeInstanceOf(SessionWindowReopenedError)
    closed.delete(USER)
    p.ingest(rawFixture('message-text'))
    await flush()

    // Uploaded once (6 bytes); the retry reuses the media id instead of re-reading the drained stream.
    expect(uploads).toEqual([{ url: expect.stringContaining('/PNID/media'), size: 6 }])
    const images = calls.filter((c) => c.body.type === 'image').map((c) => c.body.image)
    expect(images).toEqual([{ id: 'MEDIA1', caption: 'pic' }, { id: 'MEDIA1', caption: 'pic' }])
    expect(reports.map((r) => r.outcome)).toEqual(['queued', 'sent'])
  })

  it('a stream media send failed by a 131047 status is resent with the uploaded media', async () => {
    const uploads: Array<{ url: string; size: number }> = []
    const calls = mockGraph(new Set(), uploads)
    const reports: SessionReport[] = []
    // Clock right after the fixtures: the status (1751400200) predates the inbound (1751400300).
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE, now: () => 1751400310_000, onReport: (r) => reports.push(r) } })
    p.ingest(rawFixture('message-text'))
    await flush()
    const res = await p.send(USER, { kind: 'document', media: { stream: streamOf('pdf-bytes') }, filename: 'a.pdf' })
    p.ingest(rawFixture('status-failed-131047').replace('wamid.LATE', res.ref.id))
    await flush()

    expect(uploads.map((u) => u.size)).toEqual([9])
    const docs = calls.filter((c) => c.body.type === 'document').map((c) => c.body.document)
    expect(docs).toEqual([{ id: 'MEDIA1', filename: 'a.pdf' }, { id: 'MEDIA1', filename: 'a.pdf' }])
    expect(reports.at(-1)).toMatchObject({ outcome: 'sent', reason: 'status' })
  })

  it('the manager never keeps media bytes: queued and tracked content carry the media id', async () => {
    const uploads: Array<{ url: string; size: number }> = []
    mockGraph(new Set([USER]), uploads)
    const reports: SessionReport[] = []
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE, now: () => 1751400290_000, onReport: (r) => reports.push(r) } })
    await expect(p.send(USER, { kind: 'video', media: Buffer.alloc(1024) })).rejects.toBeInstanceOf(SessionWindowReopenedError)
    const queued = reports.find((r) => r.outcome === 'queued')!
    expect(queued.content).toEqual({ kind: 'video', media: { native: { id: 'MEDIA1' } } })
    expect(uploads).toHaveLength(1)
  })

  it('a URL media source is kept as a link (no upload)', async () => {
    const uploads: Array<{ url: string; size: number }> = []
    const calls = mockGraph(new Set(), uploads)
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE } })
    await p.send(USER, { kind: 'image', media: 'https://example.com/a.png' })
    expect(uploads).toEqual([])
    expect(calls[0].body.image).toEqual({ link: 'https://example.com/a.png' })
  })
})

describe('CloudAPIProvider: session window per business number', () => {
  const cfgA = { ...baseCfg, phoneNumberId: 'PNID_A' }
  const cfgB = { ...baseCfg, phoneNumberId: 'PNID_B' }

  it('a shared manager keeps window state and queues apart per phone number', async () => {
    const closed = new Set([USER])
    const calls = mockGraph(closed)
    const reports: SessionReport[] = []
    const manager = new SessionWindowManager({ reopenTemplate: TEMPLATE, now: () => 1751400290_000, onReport: (r) => reports.push(r) })
    const a = new CloudAPIProvider({ ...cfgA, sessionWindow: manager })
    const b = new CloudAPIProvider({ ...cfgB, sessionWindow: manager })
    expect(a.sessionWindow).not.toBe(b.sessionWindow)

    // Queued through B (B's window with the user is closed).
    await expect(b.send(USER, { kind: 'text', text: 'from B' })).rejects.toBeInstanceOf(SessionWindowReopenedError)
    closed.delete(USER)

    // The user writes to A: A's window opens, B's stays closed, and B's queue is not drained by A.
    a.ingest(rawFixture('message-text'))
    await flush()
    expect(await a.sessionWindow!.isOpen(USER)).toBe(true)
    expect(await b.sessionWindow!.isOpen(USER)).toBe(false)
    expect(b.sessionWindow!.pending(USER)).toBe(1)
    expect(calls.filter((c) => c.url.includes('PNID_A'))).toHaveLength(0)

    // The user writes to B: B delivers its own queue from B's number.
    b.ingest(rawFixture('message-text'))
    await flush()
    const last = calls.at(-1)!
    expect(last.url).toContain('/PNID_B/messages')
    expect(last.body).toMatchObject({ type: 'text', text: { body: 'from B' } })
    expect(reports.map((r) => r.outcome)).toEqual(['queued', 'sent'])
  })

  it('options with a shared store key the window state by phone number', async () => {
    mockGraph(new Set())
    const data = new Map<string, SessionWindowState>()
    const store = {
      get: (id: string) => data.get(id),
      set: (id: string, st: SessionWindowState) => { data.set(id, st) },
      delete: (id: string) => { data.delete(id) },
    }
    const now = (): number => 1751400310_000
    const a = new CloudAPIProvider({ ...cfgA, sessionWindow: { store, now } })
    const b = new CloudAPIProvider({ ...cfgB, sessionWindow: { store, now } })
    a.ingest(rawFixture('message-text'))
    await flush()
    expect(await a.sessionWindow!.state(USER)).toBe('open')
    expect(await b.sessionWindow!.state(USER)).toBe('unknown')
    expect([...data.keys()]).toEqual([`PNID_A:${USER}`])
  })
})

describe('CloudAPIProvider: session window with an async store', () => {
  it('a handler replying to the reopening message is not rejected while the store write is pending', async () => {
    const closed = new Set([USER])
    const calls = mockGraph(closed)
    const data = new Map<string, SessionWindowState>()
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
    const store = {
      get: async (id: string) => { await tick(); const s = data.get(id); return s ? { ...s } : undefined },
      set: async (id: string, st: SessionWindowState) => { await tick(); data.set(id, { ...st }) },
      delete: async (id: string) => { await tick(); data.delete(id) },
    }
    const now = (): number => 1751400290_000
    const p = new CloudAPIProvider({ ...baseCfg, sessionWindow: { reopenTemplate: TEMPLATE, store, now } })
    await expect(p.send(USER, { kind: 'text', text: 'queued' })).rejects.toBeInstanceOf(SessionWindowReopenedError)
    closed.delete(USER)

    const replies: Array<Promise<unknown>> = []
    p.onEvent((e) => {
      if (e.kind === 'message') replies.push(p.send(e.message.chatId, { kind: 'text', text: 'reply' }))
    })
    p.ingest(rawFixture('message-text'))
    await expect(replies[0]).resolves.toMatchObject({ ref: { chatId: USER } })
    await flush()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.map((c) => c.body.type === 'template' ? 'T' : (c.body.text as { body: string }).body))
      .toEqual(['queued', 'T', 'queued', 'reply'])
  })
})

describe('CloudAPIProvider: pricing and usage', () => {
  it('exposes pricing in status platformData and aggregates usage per chat/category', async () => {
    const p = new CloudAPIProvider({ ...baseCfg, usage: { rates: { marketing: 0.0125 } } })
    const statuses: DeliveryStatus[] = []
    p.onEvent((e) => { if (e.kind === 'status') statuses.push(e.status) })
    p.ingest(rawFixture('status-pmp-marketing'))
    // Meta repeats the pricing on `read`: counted once.
    p.ingest(rawFixture('status-pmp-marketing').replace('"delivered"', '"read"'))
    p.ingest(rawFixture('status-pmp-free-service'))
    p.ingest(rawFixture('status-cbp-conversation'))

    expect(statuses[0].platformData).toEqual({ pricing: { billable: true, pricingModel: 'PMP', category: 'marketing', type: 'regular' } })
    const chat = p.usage!.forChat(USER)!
    expect(chat).toMatchObject({ messages: 3, billable: 1, free: 2, estimatedCost: 0.0125 })
    expect(Object.keys(chat.byCategory).sort()).toEqual(['marketing', 'service', 'utility'])
    expect(p.usage!.forChat('573009998877')).toMatchObject({ messages: 1, billable: 1 })
    expect(p.usage!.totals()).toMatchObject({ messages: 4, billable: 2 })
  })

  it('accepts a shared UsageTracker or usage: false', () => {
    const shared = new UsageTracker()
    expect(new CloudAPIProvider({ ...baseCfg, usage: shared }).usage).toBe(shared)
    const off = new CloudAPIProvider({ ...baseCfg, usage: false })
    expect(off.usage).toBeUndefined()
    const statuses: DeliveryStatus[] = []
    off.onEvent((e) => { if (e.kind === 'status') statuses.push(e.status) })
    off.ingest(rawFixture('status-pmp-marketing'))
    expect(statuses[0].platformData).toBeDefined()
  })
})
