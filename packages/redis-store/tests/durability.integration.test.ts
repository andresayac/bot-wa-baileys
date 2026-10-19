/**
 * RedisDurability against a REAL Redis server (opt-in: skipped unless
 * BOTWA_TEST_REDIS_URL is set; see integration.test.ts for the docker command).
 * Every backend gets its own prefix in this run's namespace; all of it is deleted afterwards.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from 'redis'
import { Bot, MemoryStore, flow } from '@bot-wa/core'
import { CrashableProvider, MockProvider, crashable } from '@bot-wa/core/testing'
import { RedisDurability, RedisDurableKv, type RedisLikeClient } from '../src/index.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'

const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const RUN = `botwa-itd:${process.pid}-${randomUUID().slice(0, 8)}`
let seq = 0

describe.skipIf(!REDIS_URL)('RedisDurability — real Redis', () => {
  const client = createClient({ url: REDIS_URL })
  const c = client as unknown as RedisLikeClient
  const fresh = () => ({ client: c, prefix: `${RUN}:${++seq}` })

  beforeAll(async () => { await client.connect() })
  afterAll(async () => {
    const leftovers = await client.keys(`${RUN}*`)
    if (leftovers.length) await client.del(leftovers)
    await client.quit()
  })

  runDurableKvConformance('RedisDurableKv (real)', {
    async make() { return { kv: new RedisDurableKv(fresh()), teardown: async () => {} } },
  })

  runDurabilityConformance('RedisDurability (real)', {
    async make() {
      const backend = new RedisDurability(fresh())
      await backend.start()
      return { backend, teardown: () => backend.stop() }
    },
  })

  const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
  runCrashRecoveryMatrix('RedisDurability (real)', deps, {
    async make() { return { backend: new RedisDurability(fresh()), teardown: async () => {} } },
  })

  it('an own client (url) connects on start and quits on stop', async () => {
    const backend = new RedisDurability({ url: REDIS_URL, prefix: `${RUN}:own` })
    await backend.start()
    await backend.outbox.put({ key: 'k', chatId: 'c', content: 'x', createdAt: 1 }, 1)
    expect((await backend.outbox.get('k'))?.state).toBe('pending')
    await backend.stop()
  })

  it('two replicas on one prefix never claim the same record', async () => {
    const opts = fresh()
    const a = new RedisDurability(opts)
    const b = new RedisDurability(opts)
    for (let i = 0; i < 30; i++) await a.inbox.append({ id: `e${i}`, partitionKey: 'p', kind: 'message', payload: {}, receivedAt: i }, 0)
    const [x, y] = await Promise.all([
      a.inbox.claim({ owner: 'a', leaseMs: 10_000, now: 1, limit: 30 }),
      b.inbox.claim({ owner: 'b', leaseMs: 10_000, now: 1, limit: 30 }),
    ])
    const ids = [...x, ...y].map((r) => r.id)
    expect(new Set(ids).size).toBe(30)
  })
})
