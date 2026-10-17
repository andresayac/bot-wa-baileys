import { describe, it, expect, vi } from 'vitest'
import { OutsideSessionWindowError, RateLimitedError, type OutboundContent, type SendResult } from '@bot-wa/core'
import {
  MemorySessionWindowStore,
  SessionWindowManager,
  SessionWindowReopenedError,
  type RawSend,
  type SessionReport,
  type SessionTemplate,
  type SessionWindowOptions,
  type SessionWindowState,
} from '../src/sessionWindow.js'

const HOUR = 3_600_000
const TEMPLATE: SessionTemplate = { kind: 'template', name: 'reopen_chat', language: 'es' }

/** Fake transport: rejects free-form content with 131047 while the chat is in `closed`. */
function fakeTransport() {
  const sent: Array<{ chatId: string; content: OutboundContent }> = []
  const state = { closed: new Set<string>(), fail: undefined as Error | undefined, n: 0 }
  const rawSend = vi.fn<RawSend>(async (chatId, content) => {
    if (state.fail) throw state.fail
    if (content.kind !== 'template' && state.closed.has(chatId)) throw new OutsideSessionWindowError(chatId, 'Re-engagement (131047)')
    sent.push({ chatId, content })
    const result: SendResult<unknown> = { ref: { id: `wamid.${++state.n}`, chatId }, raw: {} }
    return result
  })
  return { rawSend, sent, state }
}

function setup(opts: SessionWindowOptions = {}) {
  let clock = 1_000_000_000_000
  const reports: SessionReport[] = []
  const manager = new SessionWindowManager({ now: () => clock, onReport: (r) => reports.push(r), ...opts })
  return { manager, reports, advance: (ms: number) => { clock += ms }, now: () => clock }
}

const text = (t: string): OutboundContent => ({ kind: 'text', text: t })
const ignore = (): undefined => undefined

describe('SessionWindowManager: window state', () => {
  it('is unknown before any inbound, open within 24 h, closed after', async () => {
    const { manager, advance, now } = setup()
    const { rawSend } = fakeTransport()
    expect(await manager.state('A')).toBe('unknown')
    await manager.noteInbound('A', rawSend)
    expect(await manager.state('A')).toBe('open')
    expect(await manager.expiresAt('A')).toBe(now() + 24 * HOUR)
    advance(24 * HOUR)
    expect(await manager.isOpen('A')).toBe(false)
    expect(await manager.state('A')).toBe('closed')
    expect(await manager.expiresAt('A')).toBeUndefined()
  })

  it('honours a custom windowMs and inbound timestamps (never in the future)', async () => {
    const { manager, now } = setup({ windowMs: HOUR })
    const { rawSend } = fakeTransport()
    await manager.noteInbound('A', rawSend, now() - 2 * HOUR)
    expect(await manager.state('A')).toBe('closed')
    await manager.noteInbound('B', rawSend, now() + 10 * HOUR)
    expect(await manager.expiresAt('B')).toBe(now() + HOUR)
  })

  it('an out-of-order inbound older than a 131047 does not reopen the window', async () => {
    const { manager, advance, now } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    const old = now()
    advance(HOUR)
    t.state.closed.add('A')
    await expect(manager.send('A', text('x'), undefined, t.rawSend)).rejects.toBeInstanceOf(SessionWindowReopenedError)
    await manager.noteInbound('A', t.rawSend, old)
    expect(await manager.state('A')).toBe('closed')
    expect(manager.pending('A')).toBe(1)
  })
})

describe('SessionWindowManager: reopen and retry', () => {
  it('passes sends through while the window is open, and templates always', async () => {
    const { manager } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    await expect(manager.send('A', text('hi'), undefined, t.rawSend)).resolves.toMatchObject({ ref: { id: 'wamid.1' } })
    t.state.closed.add('B')
    await expect(manager.send('B', TEMPLATE, undefined, t.rawSend)).resolves.toMatchObject({ ref: { chatId: 'B' } })
  })

  it('on OutsideSessionWindowError: sends the template, queues the content and retries it on reply', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.state.closed.add('A')
    const err = await manager.send('A', text('tu pedido'), undefined, t.rawSend).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionWindowReopenedError)
    expect(err).toBeInstanceOf(OutsideSessionWindowError)
    expect((err as SessionWindowReopenedError).queued).toBe(true)
    expect((err as SessionWindowReopenedError).templateResult?.ref.id).toBe('wamid.1')
    expect(t.sent).toEqual([{ chatId: 'A', content: TEMPLATE }])
    expect(manager.pending('A')).toBe(1)
    expect(reports.map((r) => [r.outcome, r.reason])).toEqual([['queued', 'error']])

    // The user replies: window open, the original message goes out.
    t.state.closed.delete('A')
    await manager.noteInbound('A', t.rawSend)
    expect(t.sent.at(-1)).toEqual({ chatId: 'A', content: text('tu pedido') })
    expect(manager.pending('A')).toBe(0)
    expect(reports.at(-1)).toMatchObject({ outcome: 'sent', chatId: 'A', result: { ref: { id: 'wamid.2' } } })
  })

  it('proactively skips the doomed send when the window is known closed', async () => {
    const { manager, advance } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    advance(25 * HOUR)
    t.state.closed.add('A')
    await expect(manager.send('A', text('x'), undefined, t.rawSend)).rejects.toBeInstanceOf(SessionWindowReopenedError)
    // Only the template hit the transport: the free-form attempt was skipped.
    expect(t.rawSend.mock.calls.map((c) => c[1].kind)).toEqual(['template'])
  })

  it('proactive: false always tries the free-form send first', async () => {
    const { manager, advance } = setup({ reopenTemplate: TEMPLATE, proactive: false })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    advance(25 * HOUR)
    t.state.closed.add('A')
    await manager.send('A', text('x'), undefined, t.rawSend).catch(ignore)
    expect(t.rawSend.mock.calls.map((c) => c[1].kind)).toEqual(['text', 'template'])
  })

  it('sends the reopen template only once while waiting for the reply', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.state.closed.add('A')
    for (const s of ['1', '2', '3']) await manager.send('A', text(s), undefined, t.rawSend).catch(ignore)
    expect(t.sent.filter((s) => s.content.kind === 'template')).toHaveLength(1)
    expect(manager.pending('A')).toBe(3)
    expect(reports.every((r) => r.outcome === 'queued')).toBe(true)
    t.state.closed.delete('A')
    await manager.noteInbound('A', t.rawSend)
    expect(t.sent.slice(1).map((s) => (s.content as { text: string }).text)).toEqual(['1', '2', '3'])
  })

  it("resolves with the template's send result when onReopened is 'resolve'", async () => {
    const { manager } = setup({ reopenTemplate: TEMPLATE, onReopened: 'resolve' })
    const t = fakeTransport()
    t.state.closed.add('A')
    const res = await manager.send('A', text('x'), undefined, t.rawSend)
    expect(res.ref.id).toBe('wamid.1')
    expect(res.raw).toMatchObject({ queued: true, template: TEMPLATE })
  })

  it('picks the template by content kind, then the resolver callback', async () => {
    const image: SessionTemplate = { kind: 'template', name: 'media_ready', language: 'es' }
    const resolver = vi.fn(async ({ content }: { content: OutboundContent }) =>
      content.kind === 'location' ? undefined : TEMPLATE)
    const { manager, reports } = setup({ reopenTemplate: resolver, reopenTemplateByKind: { image } })
    const t = fakeTransport()
    t.state.closed.add('A').add('B').add('C')
    await manager.send('A', { kind: 'image', media: 'https://x/i.png' }, undefined, t.rawSend).catch(ignore)
    await manager.send('B', text('x'), undefined, t.rawSend).catch(ignore)
    const err = await manager.send('C', { kind: 'location', lat: 1, lng: 2 }, undefined, t.rawSend).catch((e: unknown) => e)
    expect(t.sent.map((s) => (s.content as SessionTemplate).name)).toEqual(['media_ready', 'reopen_chat'])
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'B', reason: 'error' }))
    // No template: the original error surfaces and nothing is queued.
    expect(err).toBeInstanceOf(OutsideSessionWindowError)
    expect(err).not.toBeInstanceOf(SessionWindowReopenedError)
    expect(manager.pending('C')).toBe(0)
    expect(reports.at(-1)).toMatchObject({ outcome: 'no-template', chatId: 'C' })
  })

  it('without any template, rejects with the original error', async () => {
    const { manager } = setup()
    const t = fakeTransport()
    t.state.closed.add('A')
    await expect(manager.send('A', text('x'), undefined, t.rawSend)).rejects.toThrow(/131047/)
  })

  it('does not touch other provider errors', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.state.fail = new RateLimitedError(1000)
    await expect(manager.send('A', text('x'), undefined, t.rawSend)).rejects.toBeInstanceOf(RateLimitedError)
    expect(reports).toEqual([])
  })

  it('retryOnReply: false only reopens', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE, retryOnReply: false })
    const t = fakeTransport()
    t.state.closed.add('A')
    const err = await manager.send('A', text('x'), undefined, t.rawSend).catch((e: unknown) => e)
    expect((err as SessionWindowReopenedError).queued).toBe(false)
    expect(manager.pending('A')).toBe(0)
    expect(reports[0].outcome).toBe('reopened')
  })

  it('reports a failing reopen template and does not keep the rejected content queued', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.rawSend.mockImplementation(async (chatId, content) => {
      if (content.kind === 'template') throw new Error('template paused')
      throw new OutsideSessionWindowError(chatId)
    })
    await expect(manager.send('A', text('x'), undefined, t.rawSend)).rejects.toBeInstanceOf(OutsideSessionWindowError)
    expect(reports[0]).toMatchObject({ outcome: 'reopen-failed', error: expect.objectContaining({ message: 'template paused' }) })
    // The caller saw a rejection: the content must not be delivered later behind its back.
    expect(manager.pending('A')).toBe(0)
    t.rawSend.mockImplementation(async (chatId, content) => ({ ref: { id: 'wamid.x', chatId }, raw: content }))
    await manager.noteInbound('A', t.rawSend)
    expect(t.rawSend.mock.calls.filter((c) => c[1].kind === 'text')).toHaveLength(1)
  })

  it('a failing reopen keeps earlier queued sends (only the rejected content is dropped)', async () => {
    const { manager, advance } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.state.closed.add('A')
    await manager.send('A', text('first'), undefined, t.rawSend).catch(ignore)
    expect(manager.pending('A')).toBe(1)
    // The pending reopen expires without a reply; the next reopen template fails.
    advance(25 * 3_600_000)
    t.rawSend.mockImplementation(async (chatId, content) => {
      if (content.kind === 'template') throw new Error('template paused')
      throw new OutsideSessionWindowError(chatId)
    })
    await expect(manager.send('A', text('second'), undefined, t.rawSend)).rejects.toThrow('template paused')
    expect(manager.pending('A')).toBe(1)
  })

  it('concurrent sends to a closed chat share a single reopen template', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.state.closed.add('A')
    const results = await Promise.allSettled([
      manager.send('A', text('1'), undefined, t.rawSend),
      manager.send('A', text('2'), undefined, t.rawSend),
      manager.send('A', text('3'), undefined, t.rawSend),
    ])
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof SessionWindowReopenedError)).toBe(true)
    expect(t.sent.filter((s) => s.content.kind === 'template')).toHaveLength(1)
    expect(manager.pending('A')).toBe(3)
    expect(reports.map((r) => r.outcome)).toEqual(['queued', 'queued', 'queued'])
  })

  it('concurrent proactive reopens wait for the in-flight template', async () => {
    const { manager, advance } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    advance(25 * HOUR)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const base = t.rawSend.getMockImplementation()!
    t.rawSend.mockImplementation(async (chatId, content, options) => {
      if (content.kind === 'template') await gate
      return base(chatId, content, options)
    })
    const all = Promise.allSettled([1, 2].map((n) => manager.send('A', text(String(n)), undefined, t.rawSend)))
    await new Promise((r) => setImmediate(r))
    release()
    await all
    expect(t.rawSend.mock.calls.filter((c) => c[1].kind === 'template')).toHaveLength(1)
    expect(manager.pending('A')).toBe(2)
  })

  it('a shared reopen template that fails rejects every waiter and queues nothing', async () => {
    const { manager, reports, advance } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    advance(25 * HOUR)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    t.rawSend.mockImplementation(async (chatId, content) => {
      if (content.kind === 'template') { await gate; throw new Error('template paused') }
      throw new OutsideSessionWindowError(chatId)
    })
    const all = Promise.allSettled([1, 2].map((n) => manager.send('A', text(String(n)), undefined, t.rawSend)))
    await new Promise((r) => setImmediate(r))
    release()
    const results = await all
    expect(results.every((r) => r.status === 'rejected' && (r.reason as Error).message === 'template paused')).toBe(true)
    expect(t.rawSend.mock.calls.filter((c) => c[1].kind === 'template')).toHaveLength(1)
    expect(manager.pending('A')).toBe(0)
    expect(reports.map((r) => r.outcome)).toEqual(['reopen-failed', 'reopen-failed'])
  })

  it('discards expired entries and reports retries that fail again', async () => {
    const { manager, reports, advance } = setup({ reopenTemplate: TEMPLATE, pendingTtlMs: HOUR })
    const t = fakeTransport()
    t.state.closed.add('A').add('B')
    await manager.send('A', text('old'), undefined, t.rawSend).catch(ignore)
    advance(2 * HOUR)
    await manager.noteInbound('A', t.rawSend)
    expect(reports.at(-1)).toMatchObject({ outcome: 'expired', chatId: 'A' })

    await manager.send('B', text('b'), undefined, t.rawSend).catch(ignore)
    t.state.fail = new Error('boom')
    await manager.noteInbound('B', t.rawSend)
    expect(reports.at(-1)).toMatchObject({ outcome: 'failed', chatId: 'B', error: expect.objectContaining({ message: 'boom' }) })
  })

  it('is bounded per chat and across chats (dropped reports)', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE, maxPendingPerChat: 2, maxPendingChats: 2 })
    const t = fakeTransport()
    t.state.closed.add('A').add('B').add('C')
    for (const s of ['1', '2', '3']) await manager.send('A', text(s), undefined, t.rawSend).catch(ignore)
    expect(manager.pending('A')).toBe(2)
    expect(reports.find((r) => r.outcome === 'dropped')).toMatchObject({ chatId: 'A', content: { text: '1' } })
    await manager.send('B', text('b'), undefined, t.rawSend).catch(ignore)
    await manager.send('C', text('c'), undefined, t.rawSend).catch(ignore)
    expect(manager.pending('A')).toBe(0)
    expect(manager.pending('C')).toBe(1)
    manager.clearPending('C')
    expect(reports.at(-1)).toMatchObject({ outcome: 'dropped', chatId: 'C' })
  })

  it('handles an async 131047 status for a message it sent (report-only)', async () => {
    const { manager, reports } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    const res = await manager.send('A', text('late'), undefined, t.rawSend)
    await manager.noteFailedStatus('A', res.ref.id, 131047, t.rawSend)
    expect(await manager.state('A')).toBe('closed')
    expect(t.sent.at(-1)?.content).toEqual(TEMPLATE)
    expect(manager.pending('A')).toBe(1)
    expect(reports.at(-1)).toMatchObject({ outcome: 'queued', reason: 'status' })
    // Unrelated failures are ignored.
    await manager.noteFailedStatus('A', 'wamid.other', 131026, t.rawSend)
    expect(manager.pending('A')).toBe(1)
  })

  it('a stale 131047 (message sent before the latest reply) does not close the window', async () => {
    const { manager, reports, advance, now } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    const res = await manager.send('A', text('old'), undefined, t.rawSend)
    const sentAt = now()
    advance(HOUR)
    await manager.noteInbound('A', t.rawSend) // the user writes again
    advance(1000)
    // The failure webhook for the older message arrives late.
    await manager.noteFailedStatus('A', res.ref.id, 131047, t.rawSend, sentAt)
    expect(await manager.state('A')).toBe('open')
    // The window is open again: the failed content is resent right away, no template.
    expect(t.sent.filter((s) => s.content.kind === 'template')).toHaveLength(0)
    expect(t.sent.map((s) => (s.content as { text?: string }).text)).toEqual(['old', 'old'])
    expect(reports.at(-1)).toMatchObject({ outcome: 'sent', reason: 'status', chatId: 'A' })
  })

  it('a stale 131047 without a status timestamp uses the tracked send time', async () => {
    const { manager, advance } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    await manager.noteInbound('A', t.rawSend)
    const res = await manager.send('A', text('old'), undefined, t.rawSend)
    advance(HOUR)
    await manager.noteInbound('A', t.rawSend)
    advance(1000)
    await manager.noteFailedStatus('A', res.ref.id, 131047, t.rawSend)
    expect(await manager.state('A')).toBe('open')
  })

  it('a stale 131047 for an untracked message uses the status timestamp', async () => {
    const { manager, advance, now } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    const failedAt = now()
    advance(HOUR)
    await manager.noteInbound('A', t.rawSend)
    advance(1000)
    await manager.noteFailedStatus('A', 'wamid.unknown', 131047, t.rawSend, failedAt)
    expect(await manager.state('A')).toBe('open')
    // A fresh failure after the reply still closes it.
    advance(1000)
    await manager.noteFailedStatus('A', 'wamid.unknown2', 131047, t.rawSend, now())
    expect(await manager.state('A')).toBe('closed')
  })

  it('serialises concurrent flushes so nothing is sent twice', async () => {
    const { manager } = setup({ reopenTemplate: TEMPLATE })
    const t = fakeTransport()
    t.state.closed.add('A')
    await manager.send('A', text('once'), undefined, t.rawSend).catch(ignore)
    t.state.closed.delete('A')
    await Promise.all([manager.noteInbound('A', t.rawSend), manager.noteInbound('A', t.rawSend)])
    expect(t.sent.filter((s) => s.content.kind === 'text')).toHaveLength(1)
  })

  it('swallows errors thrown by onReport', async () => {
    const manager = new SessionWindowManager({ reopenTemplate: TEMPLATE, onReport: () => { throw new Error('observer') } })
    const t = fakeTransport()
    t.state.closed.add('A')
    await expect(manager.send('A', text('x'), undefined, t.rawSend)).rejects.toBeInstanceOf(SessionWindowReopenedError)
  })
})

describe('SessionWindowManager: async store', () => {
  function slowStore() {
    const data = new Map<string, SessionWindowState>()
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
    return {
      data,
      get: async (id: string) => { await tick(); const s = data.get(id); return s ? { ...s } : undefined },
      set: async (id: string, s: SessionWindowState) => { await tick(); data.set(id, { ...s }) },
      delete: async (id: string) => { await tick(); data.delete(id) },
    }
  }

  it('a send right after a not-yet-persisted inbound sees the window open and goes after the queue', async () => {
    const store = slowStore()
    const { manager } = setup({ reopenTemplate: TEMPLATE, store })
    const t = fakeTransport()
    t.state.closed.add('A')
    await manager.send('A', text('queued'), undefined, t.rawSend).catch(ignore)
    expect(manager.pending('A')).toBe(1)
    t.state.closed.delete('A')
    // Inbound recorded fire-and-forget, then the handler replies immediately.
    const inbound = manager.noteInbound('A', t.rawSend)
    const reply = manager.send('A', text('reply'), undefined, t.rawSend)
    await expect(reply).resolves.toMatchObject({ ref: { chatId: 'A' } })
    await inbound
    expect(t.sent.map((s) => s.content.kind === 'template' ? 'T' : (s.content as { text: string }).text)).toEqual(['T', 'queued', 'reply'])
  })

  it('serialises read-modify-write of window state per chat', async () => {
    const store = slowStore()
    const { manager, advance, now } = setup({ reopenTemplate: TEMPLATE, store })
    const t = fakeTransport()
    const closedAt = now()
    advance(1000)
    await Promise.all([
      manager.noteInbound('A', t.rawSend),
      manager.noteFailedStatus('A', 'wamid.none', 131047, t.rawSend, closedAt),
    ])
    // Neither write lost the other's field.
    expect(store.data.get('A')).toEqual({ lastInboundAt: now(), closedAt })
    expect(await manager.state('A')).toBe('open')
  })
})

describe('MemorySessionWindowStore', () => {
  it('is bounded and returns copies', () => {
    const store = new MemorySessionWindowStore({ maxChats: 2 })
    store.set('A', { lastInboundAt: 1 })
    store.set('B', { lastInboundAt: 2 })
    store.set('C', { lastInboundAt: 3 })
    expect(store.size).toBe(2)
    expect(store.get('A')).toBeUndefined()
    const b = store.get('B')!
    b.lastInboundAt = 99
    expect(store.get('B')).toEqual({ lastInboundAt: 2 })
    store.delete('B')
    expect(store.get('B')).toBeUndefined()
  })

  it('accepts an async custom store', async () => {
    const data = new Map<string, { lastInboundAt?: number }>()
    const store = {
      get: async (id: string) => data.get(id),
      set: async (id: string, s: { lastInboundAt?: number }) => { data.set(id, s) },
      delete: async (id: string) => { data.delete(id) },
    }
    const { manager } = setup({ store })
    await manager.noteInbound('A', fakeTransport().rawSend)
    expect(data.get('A')?.lastInboundAt).toBeGreaterThan(0)
    expect(await manager.isOpen('A')).toBe(true)
  })
})
