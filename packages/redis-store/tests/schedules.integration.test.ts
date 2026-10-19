/**
 * RedisScheduleStore / RedisLeaseProvider — against a REAL Redis server.
 *
 * Skipped unless BOTWA_TEST_REDIS_URL is set (see integration.test.ts for the
 * Docker command). Every store uses its own prefix under a per-run namespace,
 * and every key under that namespace is deleted afterwards.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from 'redis'
import { Bot, type ScheduledRun } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { RedisStore, type NativeRedisClient } from '../src/index.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'
import { runLeaseConformance } from '../../../test-utils/lease-conformance.js'

const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const RUN = `botwa-it-sched:${process.pid}-${randomUUID().slice(0, 8)}`
let seq = 0
const nextPrefix = (tag: string): string => `${RUN}:${tag}${++seq}`
const globLiteral = (s: string): string => s.replace(/[*?[\]\\]/g, '\\$&')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!REDIS_URL)('durable scheduler stores against a real Redis server', { timeout: 20_000 }, () => {
  let admin: NativeRedisClient

  beforeAll(async () => {
    admin = createClient({ url: REDIS_URL })
    await admin.connect()
  })

  afterAll(async () => {
    if (!admin) return
    const keys = await admin.keys(`${globLiteral(RUN)}:*`)
    if (keys.length) await admin.del(keys)
    await admin.quit()
  })

  const own = async (tag: string): Promise<RedisStore> => {
    const store = new RedisStore({ url: REDIS_URL, prefix: nextPrefix(tag) })
    await store.start()
    return store
  }

  runScheduleStoreConformance('RedisScheduleStore (real Redis)', {
    async make() {
      const store = await own('sched')
      return { store: store.schedules(), teardown: () => store.stop() }
    },
  })

  runLeaseConformance('RedisLeaseProvider (real Redis)', {
    async make() {
      const store = await own('lease')
      return { lease: store.leases(), teardown: () => store.stop() }
    },
  })

  it('concurrent claims from separate connections: exactly one winner', async () => {
    const prefix = nextPrefix('race')
    const stores = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const s = new RedisStore({ url: REDIS_URL, prefix })
        await s.start()
        return s
      }),
    )
    try {
      await stores[0]!.schedules().register({ id: 'job', kind: 'interval', spec: '1000', nextRunAt: 0 }, 0)
      const results = await Promise.all(stores.map((s, i) => s.schedules().claimDue('job', `r${i}`, 10, 10_000)))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect((await stores[0]!.schedules().get('job'))?.fencingToken).toBe(1)
    } finally {
      await Promise.all(stores.map((s) => s.stop()))
    }
  })

  it('two bots sharing Redis run each slot of a durable task exactly once', async () => {
    const prefix = nextPrefix('bots')
    const runs: Array<{ bot: string; slot: number }> = []
    const makeBot = async (name: string) => {
      const store = new RedisStore({ url: REDIS_URL, prefix })
      const bot = new Bot({
        provider: new MockProvider(),
        store,
        botId: 'shared',
        scheduler: { store: store.schedules(), lease: store.leases(), owner: name, tickMs: 100 },
      })
      bot.every(300, { id: 'tick', leaseMs: 2000 }, (run: ScheduledRun) => {
        runs.push({ bot: name, slot: run.scheduledAt.getTime() })
      })
      await bot.start()
      return bot
    }
    const a = await makeBot('a')
    const b = await makeBot('b')
    await sleep(1700)
    await a.stop()
    // The follower takes over once the leader is gone (it released its lease on stop).
    const before = runs.length
    await sleep(1200)
    await b.stop()

    const slots = runs.map((r) => r.slot)
    expect(new Set(slots).size).toBe(slots.length)
    expect(before).toBeGreaterThanOrEqual(3)
    expect(runs.slice(before).some((r) => r.bot === 'b')).toBe(true)
    for (let i = 1; i < slots.length; i++) expect(slots[i]! - slots[i - 1]!).toBe(300)
  })
})
