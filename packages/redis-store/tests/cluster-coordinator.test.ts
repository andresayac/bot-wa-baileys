/**
 * RedisCoordinator in the cluster key layout (hermetic: the cluster fake rejects
 * cross-slot scripts, and the legacy TURN_SCRIPT, which builds heartbeat keys in Lua).
 */
import { describe, expect, it, vi } from 'vitest'
import { Bot, CoordinationUnavailableError, MemoryStore } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { RedisCoordinator, RedisStore } from '../src/index.js'
import { PROBE_EXISTS_SCRIPT, TURN_CLUSTER_SCRIPT } from '../src/clusterScripts.js'
import { coordKeys } from '../src/layout.js'
import { ClusterFakeRedisClient } from './fakeClusterRedis.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const K = coordKeys('botwa', 'cluster')

function pair(fake = new ClusterFakeRedisClient(), leaseMs = 10_000) {
  const a = new RedisCoordinator({ client: fake, replicaId: 'a', leaseMs })
  const b = new RedisCoordinator({ client: fake, replicaId: 'b', leaseMs })
  return { fake, a, b }
}

describe('RedisCoordinator (cluster layout)', () => {
  it('grants turns in ticket order across replicas on tagged keys', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const t1 = await a.reserve('chat')
    const t2 = await b.reserve('chat')
    expect(fake.coord.get('botwa:co:{t:chat}:seq')).toBe('2')
    const turn1 = await a.acquireTurn(t1)
    let got2 = false
    const p2 = b.acquireTurn(t2).then((t) => { got2 = true; return t })
    await sleep(30)
    expect(got2).toBe(false)
    await turn1.release()
    const turn2 = await p2
    expect(turn2.fence).toBe(2)
    expect(turn2.previousHolder).toBe(a.incarnation)
    await turn2.release()
    expect(fake.evals).not.toContain(PROBE_EXISTS_SCRIPT) // a's ticket was held/live: no probe needed
    await a.stop(); await b.stop()
  })

  it('skips the tickets of a dead replica after probing its heartbeat', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    await a.acquireTurn(await a.reserve('chat'))
    await a.reserve('chat')                           // queued ticket of the replica about to die
    const tb = await b.reserve('chat')
    a.simulateCrash()
    fake.coord.expireNow(K.rep(a.incarnation))
    fake.coord.expireNow(K.turn('chat').owner)
    const turn = await b.acquireTurn(tb, { maxWaitMs: 1000 })
    expect(turn.fence).toBe(3)
    expect(turn.previousHolder).toBe(a.incarnation)
    expect(fake.evals.filter((s) => s === PROBE_EXISTS_SCRIPT).length).toBeGreaterThanOrEqual(1)
    await turn.release()
    await b.stop()
  })

  it('never skips the ticket of a live replica', async () => {
    const { a, b } = pair()
    await a.start(); await b.start()
    await a.reserve('chat')                           // a is alive, its ticket not acquired yet
    const tb = await b.reserve('chat')
    await expect(b.acquireTurn(tb, { maxWaitMs: 60 })).rejects.toBeInstanceOf(CoordinationUnavailableError)
    await a.stop(); await b.stop()
  })

  it('a heartbeat revived after the probe cannot produce two holders: the skipped replica is superseded', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const first = await b.acquireTurn(await b.reserve('chat'))
    const ta = await a.reserve('chat')
    const tb = await b.reserve('chat')
    fake.coord.expireNow(K.rep(a.incarnation))       // a paused: heartbeat lapsed
    // a's heartbeat comes back right after b probed it (a woke up).
    const evalOrig = fake.eval.bind(fake)
    fake.eval = async (script, o) => {
      const r = await evalOrig(script, o)
      if (script === PROBE_EXISTS_SCRIPT) fake.coord.set(K.rep(a.incarnation), '1', 10_000)
      return r
    }
    await first.release()
    const turn = await b.acquireTurn(tb, { maxWaitMs: 1000 })
    expect(turn.fence).toBe(3)
    await expect(a.acquireTurn(ta)).rejects.toMatchObject({ name: 'LeaseLostError', reason: 'superseded' })
    await turn.release()
    await a.stop(); await b.stop()
  })

  it('waits behind its own earlier ticket without probing', async () => {
    const { fake, a } = pair()
    await a.start()
    const t1 = await a.reserve('chat')
    const t2 = await a.reserve('chat')
    const p2 = a.acquireTurn(t2)
    await sleep(20)
    expect(fake.evals.filter((s) => s === TURN_CLUSTER_SCRIPT).length).toBeGreaterThan(1)
    expect(fake.evals).not.toContain(PROBE_EXISTS_SCRIPT)
    await (await a.acquireTurn(t1)).release()
    expect((await p2).fence).toBe(2)
    await a.stop()
  })

  it('elects one leader per name with growing terms on tagged keys', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const la = await a.tryLead('provider:x')
    expect(la?.fence).toBe(1)
    expect(await b.tryLead('provider:x')).toBeNull()
    const pb = b.lead('provider:x')
    await la!.release()
    expect((await pb).fence).toBe(2)
    fake.coord.expireNow(K.lead('provider:x').lease)
    expect((await a.tryLead('provider:x'))?.fence).toBe(3)
    expect(fake.coord.get('botwa:co:{ld:provider%3Ax}:term')).toBe('3')
    await a.stop(); await b.stop()
  })

  it('stop() releases turns and withdraws tickets on tagged keys', async () => {
    const { fake, a, b } = pair()
    await a.start(); await b.start()
    const held = await b.acquireTurn(await b.reserve('chat'))
    await a.reserve('chat')
    await a.reserve('chat')
    await a.stop()
    const left = [...(fake.coord.hashes.get(K.turn('chat').tix)?.values() ?? [])]
    expect(left.filter((h) => h === a.incarnation)).toEqual([])
    await held.release()
    await b.stop()
  })

  it('two bots sharing a cluster keep one chat in ingress order, never concurrently', async () => {
    const fake = new ClusterFakeRedisClient()
    const store = new MemoryStore()
    const bots = ['a', 'b'].map((id) => {
      const provider = new MockProvider()
      const coordinator = new RedisStore({ client: fake }).coordinator({ replicaId: id, maxPollMs: 5 })
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
      await vi.waitFor(() => expect(Number(fake.coord.get(K.turn('chat').seq))).toBe(i + 1), { interval: 1 })
    }
    await vi.waitFor(() => expect(seen).toHaveLength(N), { timeout: 5000 })
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => `m${i}`))
    expect(overlap).toBe(false)
    for (const { bot } of bots) await bot.stop()
  })
})
