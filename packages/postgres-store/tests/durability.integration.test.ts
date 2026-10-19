/**
 * PostgresDurability against a REAL PostgreSQL server (opt-in: skipped unless
 * BOTWA_TEST_POSTGRES_URL is set; see integration.test.ts for the docker command).
 * Every backend gets its own random table prefix; all of them are dropped afterwards.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { Bot, MemoryStore, flow } from '@bot-wa/core'
import { CrashableProvider, MockProvider, crashable } from '@bot-wa/core/testing'
import { PostgresDurability, PostgresDurableKv } from '../src/index.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'

const URL = process.env.BOTWA_TEST_POSTGRES_URL

describe.skipIf(!URL)('PostgresDurability — real PostgreSQL', () => {
  const run = `itd${randomBytes(4).toString('hex')}_`
  let n = 0
  // One pool for the whole file: a pool per backend would exhaust max_connections.
  const pool = URL ? new pg.Pool({ connectionString: URL, max: 10 }) : (undefined as unknown as pg.Pool)
  const prefixes: string[] = []
  const fresh = () => {
    const tablePrefix = `${run}${n++}_`
    prefixes.push(tablePrefix)
    return { pool, tablePrefix }
  }

  afterAll(async () => {
    for (const p of prefixes) await pool.query(`DROP TABLE IF EXISTS ${p}durable`)
    await pool.end()
  })

  runDurableKvConformance('PostgresDurableKv (real)', {
    async make() {
      const kv = new PostgresDurableKv(fresh())
      await kv.start()
      return { kv, teardown: () => kv.stop() }
    },
  })

  runDurabilityConformance('PostgresDurability (real)', {
    async make() {
      const backend = new PostgresDurability(fresh())
      await backend.start()
      return { backend, teardown: () => backend.stop() }
    },
  })

  const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
  runCrashRecoveryMatrix('PostgresDurability (real)', deps, {
    async make() { return { backend: new PostgresDurability(fresh()), teardown: async () => {} } },
  })

  it('replicas booting at once create the schema without errors', async () => {
    const { tablePrefix } = fresh()
    await Promise.all(Array.from({ length: 6 }, () => new PostgresDurableKv({ pool, tablePrefix }).start()))
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${tablePrefix}durable`)
    expect(rows[0].n).toBe(0)
  })

  it('two backends (replicas) on one table never claim the same record', async () => {
    const a = new PostgresDurability(fresh())
    const shared = prefixes[prefixes.length - 1]
    const b = new PostgresDurability({ pool, tablePrefix: shared })
    await a.start(); await b.start()
    for (let i = 0; i < 30; i++) await a.inbox.append({ id: `e${i}`, partitionKey: 'p', kind: 'message', payload: {}, receivedAt: i }, 0)
    const [x, y] = await Promise.all([
      a.inbox.claim({ owner: 'a', leaseMs: 10_000, now: 1, limit: 30 }),
      b.inbox.claim({ owner: 'b', leaseMs: 10_000, now: 1, limit: 30 }),
    ])
    const ids = [...x, ...y].map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(30)
  })
})
