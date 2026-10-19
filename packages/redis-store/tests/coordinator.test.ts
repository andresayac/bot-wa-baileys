/**
 * RedisCoordinator + fenced lock — hermetic unit tests (in-memory fake; the real
 * scripts run in coordination.integration.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { Bot, CoordinationUnavailableError, LeaseLostError, MemoryStore } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { RedisCoordinator, RedisStore } from '../src/index.js'
import { FakeRedisClient } from './fakeRedis.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pair(fake = new FakeRedisClient(), leaseMs = 10_000) {
  const a = new RedisCoordinator({ client: fake, replicaId: 'a', leaseMs })
  const b = new RedisCoordinator({ client: fake, replicaId: 'b', leaseMs })
  return { fake, a, b }
}

describe('RedisCoordinator (fake Redis)', () => {
  it('grants one key\'s turns in ticket order across replicas and reports the previous holder', async () => {
    const { a, b } = pair()
    await a.start(); await b.start()
    const t1 = await a.reserve('chat')
    const t2 = await b.reserve('chat')
    expect([t1.seq, t2.seq]).toEqual([1, 2])
    const turn1 = await a.acquireTurn(t1)
    expect(turn1.previousHolder).toBeNull()
    let got2 = false
    const p2 = b.acquireTurn(t2).then((t) => { got2 = true; return t })
    await sleep(30)
    expect(got2).toBe(false)
    await turn1.release()
    const turn2 = await p2
    expect(turn2.fence).toBe(2)
    expect(turn2.previousHolder).toBe('a')
    await turn2.release()
    await a.stop(); await b.stop()
  })

  it('skips the ticket and the turn of a dead replica once its heartbeat and lease expire', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const held = await a.acquireTurn(await a.reserve('chat'))
    expect(held.fence).toBe(1)
    await a.reserve('chat')                          // queued ticket of the replica about to die
    const tb = await b.reserve('chat')
    a.simulateCrash()
    fake.coord.expireNow('botwa:co:rep:a')
    fake.coord.expireNow('botwa:co:t:chat:owner')
    const turn = await b.acquireTurn(tb, { maxWaitMs: 1000 })
    expect(turn.fence).toBe(3)
    await turn.release()
    await b.stop()
  })

  it('a replica whose ticket was skipped while it looked dead is told it was superseded', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const first = await b.acquireTurn(await b.reserve('chat'))
    const ta = await a.reserve('chat')
    const tb = await b.reserve('chat')
    fake.coord.expireNow('botwa:co:rep:a')          // a paused: heartbeat lapsed
    await first.release()
    const turn = await b.acquireTurn(tb)            // a's ticket skipped
    await turn.release()
    await expect(a.acquireTurn(ta)).rejects.toMatchObject({ name: 'LeaseLostError', reason: 'superseded' })
    await a.stop(); await b.stop()
  })

  it('times out a turn wait and withdraws the ticket', async () => {
    const { a } = pair()
    await a.start()
    const first = await a.acquireTurn(await a.reserve('chat'))
    const t2 = await a.reserve('chat')
    const t3 = await a.reserve('chat')
    await expect(a.acquireTurn(t2, { maxWaitMs: 20 })).rejects.toBeInstanceOf(CoordinationUnavailableError)
    await first.release()
    expect((await a.acquireTurn(t3)).fence).toBe(3)
    await a.stop()
  })

  it('the watchdog aborts a turn whose lease is gone and reports it', async () => {
    const fake = new FakeRedisClient()
    const a = new RedisCoordinator({ client: fake, replicaId: 'a', leaseMs: 90 })
    await a.start()
    const lost = vi.fn()
    a.on('lease-lost', lost)
    const turn = await a.acquireTurn(await a.reserve('chat'))
    fake.coord.del('botwa:co:t:chat:owner')          // e.g. expired during a pause
    await vi.waitFor(() => expect(turn.signal.aborted).toBe(true), { timeout: 1000 })
    expect(() => turn.assertHeld()).toThrow(LeaseLostError)
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ key: 'chat', fence: 1, reason: 'expired' }))
    await a.stop()
  })

  it('gives every lease up locally when Redis stops answering, before the server-side lease could expire', async () => {
    const fake = new FakeRedisClient()
    let down = false
    const flaky = { eval: (s: string, o?: { keys?: string[]; arguments?: string[] }) => (down ? Promise.reject(new Error('ECONNRESET')) : fake.eval(s, o)) }
    const a = new RedisCoordinator({ client: flaky, replicaId: 'a', leaseMs: 120 })
    await a.start()
    const turn = await a.acquireTurn(await a.reserve('chat'))
    const lead = await a.tryLead('provider:x')
    const grantedAt = performance.now()
    down = true
    await vi.waitFor(() => expect(turn.signal.aborted).toBe(true), { timeout: 1000 })
    expect(performance.now() - grantedAt).toBeLessThan(120 + 60)
    expect(turn.signal.reason).toMatchObject({ reason: 'coordinator-down' })
    expect(lead!.signal.aborted).toBe(true)
    down = false
    await a.stop()
  })

  it('elects one leader per name, with a larger term each time it changes hands', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const la = await a.tryLead('provider:x')
    expect(la?.fence).toBe(1)
    expect(await b.tryLead('provider:x')).toBeNull()
    expect((await a.tryLead('provider:x'))?.fence).toBe(1)   // re-entrant
    const pb = b.lead('provider:x')
    await la!.release()
    expect((await pb).fence).toBe(2)
    fake.coord.expireNow('botwa:co:lead:provider:x')        // b dies
    expect((await a.tryLead('provider:x'))?.fence).toBe(3)
    await a.stop(); await b.stop()
  })

  it('stop() releases what it holds so another replica proceeds at once', async () => {
    const { a, b } = pair()
    await a.start(); await b.start()
    await a.acquireTurn(await a.reserve('chat'))
    await a.tryLead('job')
    const tb = await b.reserve('chat')
    await a.stop()
    expect((await b.acquireTurn(tb, { maxWaitMs: 200 })).previousHolder).toBe('a')
    expect(await b.tryLead('job')).not.toBeNull()
    await b.stop()
  })

  it('validates its options', () => {
    expect(() => new RedisCoordinator({ client: new FakeRedisClient(), replicaId: 'a|b' })).toThrow(RangeError)
    expect(() => new RedisCoordinator({ client: new FakeRedisClient(), leaseMs: 0 })).toThrow(RangeError)
  })

  it('two bots sharing Redis keep one chat in ingress order, never concurrently', async () => {
    const fake = new FakeRedisClient()
    const store = new MemoryStore()
    const bots = ['a', 'b'].map((id) => {
      const provider = new MockProvider()
      const coordinator = new RedisCoordinator({ client: fake, replicaId: id, maxPollMs: 5 })
      return { provider, bot: new Bot({ provider, store, coordination: { coordinator } }) }
    })
    const seen: string[] = []
    let running = 0
    let overlap = false
    for (const { bot } of bots) {
      bot.onMessage(async (ctx) => {
        if (++running > 1) overlap = true
        await sleep(Math.floor(Math.random() * 3))
        seen.push(ctx.body)
        running--
      })
      await bot.start()
    }
    const N = 20
    for (let i = 0; i < N; i++) {
      bots[i % 2]!.provider.incoming(`m${i}`, { from: 'chat', id: `id${i}` })
      // Ingress order = reservation order: wait until this message holds its ticket.
      await vi.waitFor(() => expect(Number(fake.coord.get('botwa:co:t:chat:seq'))).toBe(i + 1), { interval: 1 })
    }
    await vi.waitFor(() => expect(seen).toHaveLength(N), { timeout: 5000 })
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => `m${i}`))
    expect(overlap).toBe(false)
    for (const { bot } of bots) await bot.stop()
  })

  it('RedisStore.coordinator() shares the store client and prefix', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake, prefix: 'shop' })
    const coord = store.coordinator({ replicaId: 'r1' })
    await coord.start()
    await coord.reserve('c')
    expect(fake.coord.get('shop:co:t:c:seq')).toBe('1')
    expect(fake.coord.exists('shop:co:rep:r1')).toBe(true)
    await coord.stop()
    expect(fake.coord.exists('shop:co:rep:r1')).toBe(false)
  })
})

describe('RedisStore — fenced lock', () => {
  it('returns a fence that grows on every acquisition and releases with its token', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake })
    const first = await store.acquireLockFenced('job', 10_000)
    expect(first).toMatchObject({ fence: 1 })
    expect(await store.acquireLockFenced('job', 10_000)).toBeNull()
    expect(await store.acquireLock('job', 10_000)).toBeNull()      // same lock as the legacy API
    expect(await store.releaseLock('job', first!.token)).toBe(true)
    expect((await store.acquireLockFenced('job', 10_000))?.fence).toBe(2)
  })

  it('renews only while the token owns the lock', async () => {
    const fake = new FakeRedisClient()
    const store = new RedisStore({ client: fake })
    const lock = await store.acquireLockFenced('job', 1_000)
    const before = fake.expires.get('botwa:lock:job')!
    await sleep(5)
    expect(await store.renewLock('job', lock!.token, 60_000)).toBe(true)
    expect(fake.expires.get('botwa:lock:job')!).toBeGreaterThan(before + 50_000)
    expect(await store.renewLock('job', 'stranger', 60_000)).toBe(false)
    fake.expires.set('botwa:lock:job', Date.now() - 1)
    expect(await store.renewLock('job', lock!.token, 60_000)).toBe(false)
    await expect(store.renewLock('job', lock!.token, 0)).rejects.toThrow(RangeError)
    await expect(store.acquireLockFenced('job', -1)).rejects.toThrow(RangeError)
  })
})
