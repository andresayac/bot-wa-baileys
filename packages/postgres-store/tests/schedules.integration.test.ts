/**
 * PostgresScheduleStore against a REAL PostgreSQL server (opt-in: skipped unless
 * BOTWA_TEST_POSTGRES_URL is set; see integration.test.ts for the docker command).
 * Every store gets its own random table prefix; all of them are dropped afterwards.
 * Pools carry an application_name so integration.test.ts' "kill idle backends" test,
 * which may run in parallel on the same database, leaves them alone.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { Bot, type ScheduledRun } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { PostgresScheduleStore } from '../src/schedules.js'
import { PostgresStore } from '../src/PostgresStore.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'

const URL = process.env.BOTWA_TEST_POSTGRES_URL

describe.skipIf(!URL)('PostgresScheduleStore — real PostgreSQL', () => {
  const run = `its${randomBytes(4).toString('hex')}_`
  let n = 0
  const pools: pg.Pool[] = []
  const newPool = (max = 10) => {
    const pool = new pg.Pool({ connectionString: URL, max, application_name: 'botwa-schedules-it' })
    pool.on('error', () => {})
    pools.push(pool)
    return pool
  }
  const pool = URL ? newPool() : (undefined as unknown as pg.Pool)
  const prefixes: string[] = []
  const freshPrefix = () => {
    const p = `${run}${n++}_`
    prefixes.push(p)
    return p
  }

  afterAll(async () => {
    for (const p of prefixes) await pool.query(`DROP TABLE IF EXISTS ${p}schedules`)
    for (const p of pools) await p.end()
  })

  runScheduleStoreConformance('PostgresScheduleStore (real)', {
    async make() {
      const store = new PostgresScheduleStore({ pool, tablePrefix: freshPrefix() })
      await store.start()
      return { store, teardown: async () => {} }
    },
  })

  it('gives exactly one of 20 claimers on two separate pools the occurrence', async () => {
    const tablePrefix = freshPrefix()
    const a = new PostgresScheduleStore({ pool: newPool(5), tablePrefix })
    const b = new PostgresScheduleStore({ pool: newPool(5), tablePrefix })
    await a.start()
    await a.register({ id: 'race', kind: 'interval', spec: '1000', nextRunAt: 1000 }, 0)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claimDue('race', `o${i}`, 2000, 60_000)),
    )
    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.fencingToken).toBe(1)
  })

  it('creates the schema from three instances at once', async () => {
    const tablePrefix = freshPrefix()
    const stores = [newPool(2), newPool(2), newPool(2)].map((p) => new PostgresScheduleStore({ pool: p, tablePrefix }))
    await Promise.all(stores.map((s) => s.start()))
    await stores[0].register({ id: 'x', kind: 'once', spec: '5', nextRunAt: 5 }, 0)
    expect((await stores[2].get('x'))?.nextRunAt).toBe(5)
  })

  it('persists the schedule, token and lease across store instances', async () => {
    const tablePrefix = freshPrefix()
    const first = new PostgresScheduleStore({ pool, tablePrefix })
    await first.start()
    await first.register({ id: 'p', kind: 'cron', spec: 'TZ=Europe/Madrid 0 9 * * *', nextRunAt: 10 }, 0)
    await first.claimDue('p', 'a', 10, 5000)
    const second = new PostgresScheduleStore({ pool: newPool(2), tablePrefix })
    await second.start()
    expect(await second.get('p')).toMatchObject({ spec: 'TZ=Europe/Madrid 0 9 * * *', nextRunAt: 10, fencingToken: 1, leaseOwner: 'a', leaseUntil: 5010 })
  })

  it('PostgresStore#schedules() shares the store pool and prefix', async () => {
    const tablePrefix = freshPrefix()
    const store = new PostgresStore({ pool, tablePrefix })
    await store.start()
    const s = store.schedules()
    await s.start()
    await s.register({ id: 'shared', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    const { rows } = await pool.query(`SELECT id FROM ${tablePrefix}schedules`)
    expect(rows).toEqual([{ id: 'shared' }])
    for (const t of ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors', 'user_data']) {
      await pool.query(`DROP TABLE IF EXISTS ${tablePrefix}${t}`)
    }
  })

  it('two bots share an interval task: every occurrence runs once, and a restart keeps nextRunAt', async () => {
    const tablePrefix = freshPrefix()
    const keys: string[] = []
    const makeBot = () => {
      const schedules = new PostgresScheduleStore({ pool: newPool(3), tablePrefix })
      const bot = new Bot({ provider: new MockProvider(), scheduler: { store: schedules, tickMs: 100 } })
      bot.every(300, { id: 'beat' }, (r: ScheduledRun) => { keys.push(r.occurrenceKey) })
      return { bot, schedules }
    }
    const a = makeBot()
    const b = makeBot()
    await Promise.all([a.bot.start(), b.bot.start()])
    await new Promise((r) => setTimeout(r, 2000))
    await b.bot.stop()
    const runs = keys.length
    expect(new Set(keys).size).toBe(runs)
    expect(runs).toBeGreaterThanOrEqual(5)
    await a.bot.stop()
    const stored = (await a.schedules.list()).find((r) => r.id.endsWith('beat'))!
    expect(stored.fencingToken).toBeGreaterThanOrEqual(runs)

    const c = makeBot()
    await c.bot.start()
    const after = (await c.schedules.list()).find((r) => r.id.endsWith('beat'))!
    expect(after.nextRunAt).toBe(stored.nextRunAt)
    await c.bot.stop()
  })
})
