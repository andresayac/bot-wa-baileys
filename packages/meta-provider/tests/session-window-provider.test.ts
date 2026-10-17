import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DeliveryStatus, InboundEvent } from '@bot-wa/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'
import { SessionWindowManager, SessionWindowReopenedError, type SessionReport, type SessionWindowState } from '../src/sessionWindow.js'
import { UsageTracker } from '../src/pricing.js'
import { rawFixture } from './support-fixtures.js'

interface Call { url: string; body: Record<string, unknown> }

/** Fake Graph: free-form messages to `closed` recipients fail with 131047. */
function mockGraph(closed: Set<string>) {
  const calls: Call[] = []
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
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
    expect(p.sessionWindow).toBe(manager)
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
