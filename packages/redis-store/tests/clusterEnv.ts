/**
 * Real Redis Cluster helpers for the opt-in integration suites (no-ops without
 * BOTWA_TEST_REDIS_CLUSTER_URL). Start a local cluster (see CONTRIBUTING):
 *
 *   docker run -d --name botwa-it-redis-cluster -e IP=0.0.0.0 -e INITIAL_PORT=47100 \
 *     -e MASTERS=3 -e SLAVES_PER_MASTER=1 -p 127.0.0.1:47100-47105:47100-47105 grokzen/redis-cluster:7.0.10
 *   BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100 pnpm --filter @botmesh/redis-store test
 *
 * Every address the cluster announces is mapped to the seed's host (Docker port
 * mapping), keeping the announced port. Cleanup scans every master and deletes key by
 * key (a multi-key DEL would cross slots).
 */
import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import {
  createOwnRedisClient, type NativeRedisClusterClient, type RedisClusterConnectOptions,
} from '../src/client.js'
import { scanEverywhere } from '../src/migrate.js'
import { escapeGlob } from '../src/glob.js'
import type { NativeRedisClient } from '../src/RedisStore.js'

export const CLUSTER_URL = process.env.BOTWA_TEST_REDIS_CLUSTER_URL
export const CHAOS = process.env.BOTWA_TEST_REDIS_CLUSTER_CHAOS === '1'

export function clusterOptions(url = CLUSTER_URL!): RedisClusterConnectOptions {
  const seed = new URL(url)
  return {
    rootNodes: [url],
    nodeAddressMap: (address: string) => ({ host: seed.hostname, port: Number(address.slice(address.lastIndexOf(':') + 1)) }),
  }
}

/** A connected cluster client (caller closes it). */
export async function connectCluster(url = CLUSTER_URL!): Promise<NativeRedisClusterClient> {
  const client = createOwnRedisClient({ cluster: clusterOptions(url), onError: () => {} }) as NativeRedisClusterClient
  await client.connect()
  return client
}

/** A plain connection to one node (the seed by default), for CLUSTER commands. */
export async function connectNode(url = CLUSTER_URL!): Promise<NativeRedisClient> {
  const node = createClient({ url })
  node.on('error', () => {})
  await node.connect()
  return node
}

/** Wait until the cluster reports `cluster_state:ok`. */
export async function waitClusterOk(node: NativeRedisClient, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const info = String(await node.sendCommand(['CLUSTER', 'INFO']))
    if (info.includes('cluster_state:ok')) return
    if (Date.now() > until) throw new Error(`Redis Cluster not ready: ${info.split('\n')[0]}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

export async function keySlot(node: NativeRedisClient, key: string): Promise<number> {
  return Number(await node.sendCommand(['CLUSTER', 'KEYSLOT', key]))
}

/** A unique prefix for one run (no braces: the cluster layout rejects them). */
export function runPrefix(tag: string): string {
  return `botwa-cit-${process.pid}-${randomUUID().slice(0, 8)}-${tag}`
}

/** Delete every key of a prefix on every master, one key at a time. */
export async function cleanupPrefix(cluster: NativeRedisClusterClient, prefix: string): Promise<void> {
  const keys = await scanEverywhere(cluster, `${escapeGlob(prefix)}*`)
  for (const key of keys) await cluster.del(key)
}
