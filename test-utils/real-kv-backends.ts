/**
 * The `DurableKv` backends a product store can run on, for the products' opt-in
 * integration suites: a SQLite temp file (always on) and, when their `BOTWA_TEST_*_URL`
 * is set, real PostgreSQL, Redis and Redis Cluster servers (see CONTRIBUTING.md for the
 * docker commands). Every `fresh()` returns an isolated kv (its own file, table prefix or
 * key prefix); `close()` drops everything the run created.
 *
 * Imported relatively by the product packages, which declare `@bot-wa/sqlite-store`,
 * `@bot-wa/postgres-store`, `@bot-wa/redis-store`, `pg` and `redis` as devDependencies and
 * pass them in as `deps` (Vite resolves bare imports from the importing file, so this
 * file cannot import them itself).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DurableKv } from '@bot-wa/core'

export interface KvSession {
  /** A fresh, isolated, started kv and its teardown. */
  fresh(): Promise<{ kv: DurableKv; teardown: () => Promise<void> }>
  /** Drop everything this session created and close its connections. */
  close(): Promise<void>
}

export interface RealKvBackend {
  name: string
  /** `false` when the backend's `BOTWA_TEST_*_URL` is not set (the suite skips itself). */
  enabled: boolean
  open(): Promise<KvSession>
}

/** The modules each backend needs, imported by the test file of the package. */
export interface RealKvDeps {
  sqlite: typeof import('@bot-wa/sqlite-store')
  postgres: typeof import('@bot-wa/postgres-store')
  redis: typeof import('@bot-wa/redis-store')
  pg: typeof import('pg')
  redisClient: typeof import('redis')
}

const POSTGRES_URL = process.env.BOTWA_TEST_POSTGRES_URL
const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const CLUSTER_URL = process.env.BOTWA_TEST_REDIS_CLUSTER_URL

/** Plain SQL identifier prefix, unique per run. */
const runId = () => `pit${randomUUID().replace(/-/g, '').slice(0, 10)}_`

function sqliteBackend(deps: RealKvDeps): RealKvBackend {
  return {
    name: 'SQLite (temp file)',
    enabled: true,
    async open() {
      const { SQLiteStore } = deps.sqlite
      const dir = mkdtempSync(join(tmpdir(), 'botwa-product-sqlite-'))
      let n = 0
      return {
        async fresh() {
          const store = new SQLiteStore({ file: join(dir, `kv-${n++}.db`) })
          return { kv: store.durability().kv, teardown: () => store.stop() }
        },
        async close() {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        },
      }
    },
  }
}

function postgresBackend(deps: RealKvDeps): RealKvBackend {
  return {
    name: 'PostgreSQL (real)',
    enabled: Boolean(POSTGRES_URL),
    async open() {
      const { PostgresDurableKv } = deps.postgres
      // One pool for the whole file: a pool per kv would exhaust max_connections.
      const pool = new deps.pg.Pool({ connectionString: POSTGRES_URL, max: 10, application_name: 'botwa-product-it' })
      pool.on('error', () => {})
      const run = runId()
      const prefixes: string[] = []
      let n = 0
      return {
        async fresh() {
          const tablePrefix = `${run}${n++}_`
          prefixes.push(tablePrefix)
          const kv = new PostgresDurableKv({ pool, tablePrefix })
          await kv.start()
          return { kv, teardown: () => kv.stop() }
        },
        async close() {
          for (const p of prefixes) await pool.query(`DROP TABLE IF EXISTS ${p}durable`)
          await pool.end()
        },
      }
    },
  }
}

function redisBackend(deps: RealKvDeps): RealKvBackend {
  return {
    name: 'Redis (real)',
    enabled: Boolean(REDIS_URL),
    async open() {
      const { RedisDurableKv } = deps.redis
      const client = deps.redisClient.createClient({ url: REDIS_URL })
      client.on('error', () => {})
      await client.connect()
      const run = `botwa-pit:${process.pid}-${randomUUID().slice(0, 8)}`
      let n = 0
      return {
        async fresh() {
          const kv = new RedisDurableKv({ client, prefix: `${run}:${n++}` })
          return { kv, teardown: async () => {} }
        },
        async close() {
          const leftovers = await client.keys(`${run}*`)
          if (leftovers.length) await client.del(leftovers)
          await client.quit()
        },
      }
    },
  }
}

function redisClusterBackend(deps: RealKvDeps): RealKvBackend {
  return {
    name: 'Redis Cluster (real)',
    enabled: Boolean(CLUSTER_URL),
    async open() {
      const { RedisDurableKv } = deps.redis
      const seed = new URL(CLUSTER_URL!)
      // Every address the cluster announces is mapped to the seed's host (Docker port mapping).
      const cluster = deps.redisClient.createCluster({
        rootNodes: [{ url: CLUSTER_URL! }],
        nodeAddressMap: (address: string) => ({ host: seed.hostname, port: Number(address.slice(address.lastIndexOf(':') + 1)) }),
      })
      cluster.on('error', () => {})
      await cluster.connect()
      const run = `botwa-pit-${process.pid}-${randomUUID().slice(0, 8)}`
      let n = 0
      return {
        async fresh() {
          const kv = new RedisDurableKv({ client: cluster, prefix: `${run}:${n++}` })
          return { kv, teardown: async () => {} }
        },
        async close() {
          // Delete key by key on every master (a multi-key DEL would cross slots).
          for (const master of cluster.masters) {
            const node = await cluster.nodeClient(master)
            for (const key of await node.keys(`${run}*`)) await cluster.del(key)
          }
          await cluster.quit()
        },
      }
    },
  }
}

/** The backends of this run, enabled or not (register a `describe.skipIf(!backend.enabled)` per entry). */
export function realKvBackends(deps: RealKvDeps): RealKvBackend[] {
  return [sqliteBackend(deps), postgresBackend(deps), redisBackend(deps), redisClusterBackend(deps)]
}
