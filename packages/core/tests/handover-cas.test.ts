/**
 * Compare-and-set checkpoints (coordination + a store with `setCheckpointIf`): the race the
 * local fence cannot see. A replica whose checkpoint write is already in flight when another
 * replica takes the chat and writes (a frozen VM, a GC pause between the fence check and the
 * store call) has its write REFUSED by the store, the new owner's checkpoint survives, and the
 * stale replica treats the key as a lost turn. A store without the methods keeps the blind
 * writes (one warning on start).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot, MemoryCoordinationHub, MemoryCoordinator, MemoryStore, flow, type BotConfig, type FlowCheckpoint } from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'
import { NamespacedStore } from '../src/store/NamespacedStore.js'
import { GatedCheckpointStore } from './support/gatedCheckpointStore.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind))

function spyLogger(): { logger: BotConfig['logger']; warns: Array<unknown[]> } {
  const noop = () => {}
  const warns: Array<unknown[]> = []
  const l = {
    debug: noop, info: noop, error: noop, trace: noop, fatal: noop, level: 'silent',
    warn: (...args: unknown[]) => { warns.push(args) },
    child: () => l,
  }
  return { logger: l as unknown as BotConfig['logger'], warns }
}

const bots: Bot[] = []
afterEach(async () => { for (const b of bots.splice(0)) await b.stop().catch(() => {}) })

/** The full (namespaced) key and checkpoint of conversation key `key` in the inner store. */
async function rowOf(store: MemoryStore, key: string): Promise<[string, FlowCheckpoint]> {
  const row = (await store.listCheckpoints()).find(([k]) => k === key || k.endsWith(`|${key}`))
  if (!row) throw new Error(`no checkpoint for ${key}`)
  return row
}

describe('compare-and-set checkpoint writes', () => {
  it('a write already in flight when another replica wrote the key is refused; the newer checkpoint survives and the key counts as lost', async () => {
    const store = new GatedCheckpointStore()
    const provider = new MockProvider()
    const { logger, warns } = spyLogger()
    const coordinator = new MemoryCoordinator({ hub: new MemoryCoordinationHub(), replicaId: 'a' })
    const bot = new Bot({ provider, store, logger, coordination: { coordinator } })
    bots.push(bot)
    bot.use(flow('order').persistent()
      .ask('name?', 'name')
      .ask('email?', 'email')
      .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
    await bot.start()
    provider.incoming('order', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?']))
    await vi.waitFor(async () => expect((await store.checkpointOf('c1'))?.parked).toBe(true))
    const [fullKey, parked] = await rowOf(store, 'c1')
    expect(parked.revision).toBeGreaterThan(0)

    // A's answer marker (the first write after the answer) is in flight: the fence check passed,
    // the store call has not landed. Meanwhile "replica B" (a direct store write here: the race
    // happens below every local check) takes the chat and advances the checkpoint.
    const held = store.hold((cp) => cp.answer !== undefined)
    provider.incoming('Ana', { from: 'c1' })
    await held.reached
    const theirs: FlowCheckpoint = { ...parked, state: { owner: 'b' }, updatedAt: Date.now(), revision: parked.revision! + 1 }
    expect(await store.setCheckpointIf(fullKey, theirs, parked.revision!)).toBe(true)
    held.release()

    // A's write was refused: the newer checkpoint is intact, A never advanced the flow and the
    // key was reported as a lost turn (reason 'superseded').
    await vi.waitFor(() => expect(warns.some((w) => JSON.stringify(w).includes('superseded'))).toBe(true))
    await sleep(100)
    expect(await store.checkpointOf('c1')).toEqual(theirs)
    expect(texts(provider)).toEqual(['name?'])
    expect(bot.metrics().conversations.active).toBe(0)
    // Nothing of A's clears the newer owner's row either (its conversation was suspended, not ended).
    expect(await store.checkpointOf('c1')).toEqual(theirs)
  })

  it('a new conversation entered under a stale turn cannot insert over a row another replica wrote since', async () => {
    const store = new GatedCheckpointStore()
    const provider = new MockProvider()
    const { logger, warns } = spyLogger()
    const coordinator = new MemoryCoordinator({ hub: new MemoryCoordinationHub(), replicaId: 'a' })
    const bot = new Bot({ provider, store, logger, coordination: { coordinator } })
    bots.push(bot)
    bot.use(flow('order').persistent().ask('name?', 'name').say('ok'))
    await bot.start()
    // The very first write of the flow (step 0, before its prompt) is held: another replica
    // writes a checkpoint for the key meanwhile.
    const held = store.hold((cp) => cp.step === 0)
    provider.incoming('order', { from: 'c1' })
    await held.reached
    const theirs: FlowCheckpoint = { flowId: 'order', step: 1, state: { owner: 'b' }, updatedAt: Date.now(), parked: true, revision: 1 }
    const prefix = store.writes[0]!.key
    expect(await store.setCheckpointIf(prefix, theirs, 0)).toBe(true)
    held.release()
    await vi.waitFor(() => expect(warns.some((w) => JSON.stringify(w).includes('superseded'))).toBe(true))
    await sleep(50)
    expect(await store.checkpointOf('c1')).toEqual(theirs)
    expect(texts(provider)).toEqual([]) // the prompt never went out
  })

  it('a store without setCheckpointIf keeps the blind writes and warns once on start', async () => {
    const plain = new MemoryStore()
    Object.defineProperty(plain, 'setCheckpointIf', { value: undefined })
    Object.defineProperty(plain, 'clearCheckpointIf', { value: undefined })
    const setCheckpoint = vi.spyOn(plain, 'setCheckpoint')
    const provider = new MockProvider()
    const { logger, warns } = spyLogger()
    const coordinator = new MemoryCoordinator({ hub: new MemoryCoordinationHub(), replicaId: 'a' })
    const bot = new Bot({ provider, store: plain, logger, coordination: { coordinator } })
    bots.push(bot)
    bot.use(flow('order').persistent().ask('name?', 'name').say((_ctx, c) => `hi ${String(c.state.name)}`))
    await bot.start()
    expect(warns.filter((w) => JSON.stringify(w).includes('not compare-and-set'))).toHaveLength(1)
    provider.incoming('order', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?']))
    expect(setCheckpoint).toHaveBeenCalled()
    expect((await plain.listCheckpoints())[0]?.[1].revision).toBeUndefined()
    provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?', 'hi Ana']))
  })

  it('without coordination nothing changes: blind setCheckpoint, no revision stamped', async () => {
    const store = new GatedCheckpointStore()
    const setCheckpointIf = vi.spyOn(store, 'setCheckpointIf')
    const provider = new MockProvider()
    const bot = new Bot({ provider, store, logger: spyLogger().logger })
    bots.push(bot)
    bot.use(flow('order').persistent().ask('name?', 'name').say('ok'))
    await bot.start()
    provider.incoming('order', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?']))
    expect(setCheckpointIf).not.toHaveBeenCalled()
    expect((await store.checkpointOf('c1'))?.revision).toBeUndefined()
  })

  it('a coordinated bot stamps a revision chain on the key and clears with it when the flow ends', async () => {
    const store = new GatedCheckpointStore()
    const provider = new MockProvider()
    const coordinator = new MemoryCoordinator({ hub: new MemoryCoordinationHub(), replicaId: 'a' })
    const bot = new Bot({ provider, store, logger: spyLogger().logger, coordination: { coordinator } })
    bots.push(bot)
    bot.use(flow('order').persistent().ask('name?', 'name').say('ok'))
    await bot.start()
    provider.incoming('order', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?']))
    const revisions = store.writes.map((w) => w.cp.revision)
    expect(revisions).toEqual(revisions.map((_, i) => i + 1))
    provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['name?', 'ok']))
    await vi.waitFor(async () => expect(await store.checkpointOf('c1')).toBeUndefined())
    expect(store.clears.length).toBeGreaterThan(0)
  })
})

describe('NamespacedStore and the compare-and-set methods', () => {
  const ns = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }

  it('forwards them with the namespaced key when the inner store has them', async () => {
    const inner = new MemoryStore()
    const store = new NamespacedStore(inner, ns)
    expect(typeof store.setCheckpointIf).toBe('function')
    const cp: FlowCheckpoint = { flowId: 'f', step: 1, state: {}, updatedAt: 1, revision: 1 }
    expect(await store.setCheckpointIf!('k', cp, 0)).toBe(true)
    expect(await store.getCheckpoint('k')).toEqual(cp)
    expect((await inner.listCheckpoints())[0]?.[0]).not.toBe('k')
    expect(await store.setCheckpointIf!('k', cp, 0)).toBe(false)
    expect(await store.clearCheckpointIf!('k', 0)).toBe(false)
    expect(await store.clearCheckpointIf!('k', 1)).toBe(true)
    expect(await store.getCheckpoint('k')).toBeUndefined()
  })

  it('leaves them undefined when the inner store lacks them (honest capability check)', () => {
    const inner = new MemoryStore()
    Object.defineProperty(inner, 'setCheckpointIf', { value: undefined })
    const store = new NamespacedStore(inner, ns)
    expect(store.setCheckpointIf).toBeUndefined()
    expect(store.clearCheckpointIf).toBeUndefined()
  })
})
