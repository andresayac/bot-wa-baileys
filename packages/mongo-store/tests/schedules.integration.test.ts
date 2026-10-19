/**
 * MongoScheduleStore against a REAL MongoDB server (opt-in: skipped unless
 * BOTWA_TEST_MONGO_URL is set; see integration.test.ts for the docker command). A
 * standalone mongod is enough: the store uses no transactions. Each run uses its own
 * database (dropped in afterAll) and every store a fresh collection.
 */
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot, type ScheduledRun } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import { MongoScheduleStore } from '../src/schedules.js'
import { MongoStore } from '../src/MongoStore.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'

const MONGO_URL = process.env.BOTWA_TEST_MONGO_URL
const DB_NAME = `botwa_its_${randomUUID().replace(/-/g, '').slice(0, 12)}`

describe.skipIf(!MONGO_URL)('MongoScheduleStore — real MongoDB', () => {
  const clients: MongoClient[] = []
  let client: MongoClient
  let n = 0
  const newClient = async () => {
    const c = new MongoClient(MONGO_URL as string)
    await c.connect()
    clients.push(c)
    return c
  }
  const fresh = (c = client) => new MongoScheduleStore({ collection: c.db(DB_NAME).collection(`s${n++}_schedules`) })

  beforeAll(async () => {
    client = await newClient()
  })
  afterAll(async () => {
    await client?.db(DB_NAME).dropDatabase()
    for (const c of clients) await c.close()
  })

  runScheduleStoreConformance('MongoScheduleStore (real)', {
    async make() {
      return { store: fresh(), teardown: async () => {} }
    },
  })

  it('gives exactly one of 20 claimers on two clients the occurrence', async () => {
    const other = await newClient()
    const name = `race${n++}_schedules`
    const a = new MongoScheduleStore({ collection: client.db(DB_NAME).collection(name) })
    const b = new MongoScheduleStore({ collection: other.db(DB_NAME).collection(name) })
    await a.register({ id: 'race', kind: 'interval', spec: '1000', nextRunAt: 1000 }, 0)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claimDue('race', `o${i}`, 2000, 60_000)),
    )
    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.fencingToken).toBe(1)
  })

  it('promotes a token past int32 and returns it as a number', async () => {
    const name = `big${n++}_schedules`
    const col = client.db(DB_NAME).collection<{ _id: string }>(name)
    await col.insertOne({ _id: 'big', kind: 'interval', spec: '1000', nextRunAt: 0, fencingToken: 2147483647, deleted: false, updatedAt: 0 } as never)
    const store = new MongoScheduleStore({ collection: client.db(DB_NAME).collection(name) })
    const c = await store.claimDue('big', 'a', 1, 1000)
    expect(c?.fencingToken).toBe(2147483648)
    const again = (await store.get('big'))!
    expect(typeof again.fencingToken).toBe('number')
    expect(again.fencingToken).toBe(2147483648)
  })

  it('persists the schedule, token and lease across store instances', async () => {
    const name = `p${n++}_schedules`
    const first = new MongoScheduleStore({ collection: client.db(DB_NAME).collection(name) })
    await first.register({ id: 'p', kind: 'cron', spec: 'TZ=Europe/Madrid 0 9 * * *', nextRunAt: 10 }, 0)
    await first.claimDue('p', 'a', 10, 5000)
    const other = await newClient()
    const second = new MongoScheduleStore({ collection: other.db(DB_NAME).collection(name) })
    expect(await second.get('p')).toMatchObject({ spec: 'TZ=Europe/Madrid 0 9 * * *', nextRunAt: 10, fencingToken: 1, leaseOwner: 'a', leaseUntil: 5010 })
  })

  it('MongoStore#schedules() uses the store client, database and prefix', async () => {
    const prefix = `m${n++}_`
    const store = new MongoStore({ client, dbName: DB_NAME, collectionPrefix: prefix })
    await store.start()
    await store.schedules().register({ id: 'shared', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    expect(await client.db(DB_NAME).collection(`${prefix}schedules`).countDocuments({ _id: 'shared' as never })).toBe(1)
  })

  it('two bots share an interval task: every occurrence runs once, and a restart keeps nextRunAt', async () => {
    const name = `e2e${n++}_schedules`
    const keys: string[] = []
    const makeBot = async () => {
      const c = await newClient()
      const schedules = new MongoScheduleStore({ collection: c.db(DB_NAME).collection(name) })
      const bot = new Bot({ provider: new MockProvider(), scheduler: { store: schedules, tickMs: 100 } })
      bot.every(300, { id: 'beat' }, (r: ScheduledRun) => { keys.push(r.occurrenceKey) })
      return { bot, schedules }
    }
    const a = await makeBot()
    const b = await makeBot()
    await Promise.all([a.bot.start(), b.bot.start()])
    await new Promise((r) => setTimeout(r, 2000))
    await b.bot.stop()
    const runs = keys.length
    expect(new Set(keys).size).toBe(runs)
    expect(runs).toBeGreaterThanOrEqual(5)
    await a.bot.stop()
    const stored = (await a.schedules.list()).find((r) => r.id.endsWith('beat'))!
    const c = await makeBot()
    await c.bot.start()
    const after = (await c.schedules.list()).find((r) => r.id.endsWith('beat'))!
    expect(after.nextRunAt).toBe(stored.nextRunAt)
    expect(after.fencingToken).toBe(stored.fencingToken)
    await c.bot.stop()
  })
})
