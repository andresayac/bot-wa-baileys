/**
 * Coordination fences checkpoint writes: a replica that lost a chat's turn (a step that
 * outlived settleMs, a frozen process) never overwrites — nor clears — the checkpoint
 * the replica that took the chat wrote since.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot, MemoryCoordinationHub, MemoryCoordinator, flow, type BotConfig } from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'
import { GatedCheckpointStore } from './support/gatedCheckpointStore.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const bots: Bot[] = []
afterEach(async () => { for (const b of bots.splice(0)) await b.stop().catch(() => {}) })

describe('fenced checkpoint writes', () => {
  it('a replica whose step outlived its turn cannot overwrite the new owner\'s checkpoint afterwards', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new GatedCheckpointStore()
    const make = (id: string, settleMs?: number) => {
      const provider = new MockProvider()
      const coordinator = new MemoryCoordinator({ hub, replicaId: id })
      const bot = new Bot({ provider, store, logger: silent(), coordination: { coordinator, ...(settleMs ? { settleMs } : {}) } })
      bots.push(bot)
      let frozen = id === 'a'
      bot.use(flow('order').persistent()
        .ask('name?', 'name')
        // A long computation that never checks whether the conversation is still alive.
        .do(async (_ctx, c) => { if (frozen) { frozen = false; await sleep(300) } c.state.ok = id })
        .ask('email?', 'email')
        .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
      return { bot, provider }
    }
    const a = make('a', 40)
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('order', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['name?']))
    a.provider.incoming('Ana', { from: 'c1' })
    await sleep(100)                                   // A's .do() outlived settleMs: suspended, turn released
    b.provider.incoming('wake', { from: 'c1' })        // B takes the chat, re-runs the step and parks on email?
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
    await vi.waitFor(async () => expect(await store.checkpointOf('c1')).toMatchObject({ step: 2, parked: true }))
    const writes = store.writes.length
    await sleep(350)                                   // A's frozen step finishes now
    expect(await store.checkpointOf('c1')).toMatchObject({ step: 2, parked: true, state: { ok: 'b' } })
    expect(store.writes.length).toBe(writes)
    expect(texts(a.provider)).toEqual(['name?'])
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']))
  })

  it('a step that outlives its suspension cannot overwrite nor clear the checkpoint once the SAME replica took the chat again', async () => {
    // providerSession 'leader' (Baileys): every message lands on the same replica, so the
    // turn is re-acquired by the replica whose zombie step is still running.
    const store = new GatedCheckpointStore()
    const provider = new MockProvider()
    const coordinator = new MemoryCoordinator({ hub: new MemoryCoordinationHub(), replicaId: 'a' })
    const bot = new Bot({ provider, store, logger: silent(), coordination: { coordinator, settleMs: 40 } })
    bots.push(bot)
    let frozen = true
    bot.use(flow('order').persistent()
      .ask('name?', 'name')
      // Outlives settleMs AND the 5 s the suspension waits for it to unwind.
      .do(async () => { if (frozen) { frozen = false; await sleep(5_600) } })
      .ask('email?', 'email')
      .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
    await bot.start()
    provider.incoming('order', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?']))
    provider.incoming('Ana', { from: 'c1' })
    await sleep(5_200)                                 // suspended; the unwind wait gave up on it
    provider.incoming('wake', { from: 'c1' })          // same replica re-acquires the turn and resumes
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?', 'email?']))
    await vi.waitFor(async () => expect(await store.checkpointOf('c1')).toMatchObject({ step: 2, parked: true }))
    const writes = store.writes.length
    const clears = store.clears.length
    await sleep(600)                                   // the zombie step finishes now
    expect(await store.checkpointOf('c1')).toMatchObject({ step: 2, parked: true })
    expect(store.writes.length).toBe(writes)
    expect(store.clears.length).toBe(clears)
    provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?', 'email?', 'done Ana ana@x.co']))
  }, 15_000)
})
