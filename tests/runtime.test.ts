import { describe, it, expect, vi } from 'vitest'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'

function msg(body: string, over: Partial<Parameters<ConversationRuntime['deliver']>[0]> = {}) {
  return { from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', body, type: 'text', isGroup: false, reply: vi.fn(async () => {}), ...over }
}

describe('ConversationRuntime', () => {
  it('enter + deliver resumes a suspended wait', async () => {
    const rt = new ConversationRuntime()
    const got: string[] = []
    rt.register('echo', async (c, ctx) => {
      const first = await c.waitAny()
      got.push(first.body)
    })
    const entry = rt.enter('echo', msg('start'))
    expect(rt.hasActive(rt.keyFor(msg('x')))).toBe(true)
    expect(rt.deliver(msg('hello'))).toBe(true)
    await entry
    expect(got).toEqual(['hello'])
    expect(rt.hasActive(rt.keyFor(msg('x')))).toBe(false)
  })

  it('deliver returns false when nothing active', () => {
    const rt = new ConversationRuntime()
    expect(rt.deliver(msg('hi'))).toBe(false)
  })

  it('group keys are per participant by default', () => {
    const rt = new ConversationRuntime()
    const a = msg('x', { from: 'g@g.us', sender: 'u1@s.whatsapp.net', isGroup: true })
    const b = msg('x', { from: 'g@g.us', sender: 'u2@s.whatsapp.net', isGroup: true })
    expect(rt.keyFor(a)).not.toBe(rt.keyFor(b))
  })

  it('timeout sends timeoutMessage and ends conversation', async () => {
    vi.useFakeTimers()
    const rt = new ConversationRuntime({ defaultTimeoutMs: 1000, timeoutMessage: 'bye-timeout' })
    const start = msg('start')
    const entry = rt.enter(async (c) => { await c.waitAny() }, start)
    await vi.advanceTimersByTimeAsync(1001)
    await entry
    expect(start.reply).toHaveBeenCalledWith('bye-timeout')
    expect(rt.hasActive(rt.keyFor(start))).toBe(false)
    vi.useRealTimers()
  })

  it('abort rejects pending wait with cancelled', async () => {
    const rt = new ConversationRuntime({ cancelledMessage: undefined })
    const start = msg('start')
    let cancelled = false
    const entry = rt.enter(async (c) => {
      try { await c.waitAny() } catch (e) { cancelled = e instanceof Error; throw e }
    }, start)
    rt.abort(rt.keyFor(start))
    await entry
    expect(cancelled).toBe(true)
  })

  it('messages arriving while processing land in inbox and feed next wait', async () => {
    const rt = new ConversationRuntime()
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const entry = rt.enter(async (c) => {
      await gate                       // "procesando": sin wait pendiente
      seen.push((await c.waitAny()).body)
    }, msg('start'))
    expect(rt.deliver(msg('queued'))).toBe(true)   // va al inbox
    release()
    await entry
    expect(seen).toEqual(['queued'])
  })

  it('filter rejection leaves message unconsumed', async () => {
    const rt = new ConversationRuntime()
    const start = msg('start')
    const entry = rt.enter(async (c) => {
      await c.waitAny({ filter: (m) => m.type === 'image' })
    }, start)
    expect(rt.deliver(msg('texto plano'))).toBe(false)     // sigue pipeline
    rt.abort(rt.keyFor(start))
    await entry.catch(() => {})
  })

  it('unhandled error sends errorMessage and cleans up', async () => {
    const rt = new ConversationRuntime({ errorMessage: 'boom-msg' })
    const start = msg('start')
    await rt.enter(async () => { throw new Error('boom') }, start)
    expect(start.reply).toHaveBeenCalledWith('boom-msg')
    expect(rt.hasActive(rt.keyFor(start))).toBe(false)
  })

  it('re-entering a key replaces the old conversation without killing the new one', async () => {
    const rt = new ConversationRuntime()
    const start = msg('start')
    const key = rt.keyFor(start)
    const gotB: string[] = []
    const entryA = rt.enter(async (c) => { await c.waitAny() }, start)
    const entryB = rt.enter(async (c) => { gotB.push((await c.waitAny()).body) }, msg('start-b'))
    await entryA                                          // A settles (cancelled by re-entry)
    expect(rt.hasActive(key)).toBe(true)                  // B must still be alive
    expect(rt.deliver(msg('for-b'))).toBe(true)
    await entryB
    expect(gotB).toEqual(['for-b'])
  })

  it('abort makes deliver return false immediately', async () => {
    const rt = new ConversationRuntime()
    const start = msg('start')
    const entry = rt.enter(async (c) => { await c.waitAny() }, start)
    rt.abort(rt.keyFor(start))
    expect(rt.deliver(msg('x'))).toBe(false)              // synchronously after abort
    await entry
  })

  it("stale conversation cannot steal the new entry's wait", async () => {
    const rt = new ConversationRuntime()
    const start = msg('start')
    const key = rt.keyFor(start)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let aRejected = false
    const entryA = rt.enter(async (c) => {
      await gate                                          // parked: no pending wait
      await c.waitAny().catch((e) => { aRejected = true; throw e })
    }, start)
    rt.abort(key)                                         // no pending to reject: flags cancelled
    const gotB: string[] = []
    const entryB = rt.enter(async (c) => { gotB.push((await c.waitAny()).body) }, msg('start-b'))
    release()
    await entryA                                          // A's waitAny must reject as cancelled
    expect(aRejected).toBe(true)
    expect(rt.deliver(msg('to-b'))).toBe(true)            // B keeps its own wait
    await entryB
    expect(gotB).toEqual(['to-b'])
  })
})
