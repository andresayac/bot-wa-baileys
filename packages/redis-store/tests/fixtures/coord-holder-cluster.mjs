// Child process for the cluster failover integration test: joins as replica "dying" on a
// Redis Cluster, takes the turn of `key` and holds it until the parent kills this process.
// Usage: node coord-holder-cluster.mjs <seedUrl> <prefix> <key> <leaseMs>
import { RedisCoordinator } from '../../lib/index.js'

const [url, prefix, key, leaseMs] = process.argv.slice(2)
const seed = new URL(url)
const coord = new RedisCoordinator({
  cluster: {
    rootNodes: [url],
    nodeAddressMap: (address) => ({ host: seed.hostname, port: Number(address.slice(address.lastIndexOf(':') + 1)) }),
  },
  prefix,
  replicaId: 'dying',
  leaseMs: Number(leaseMs),
})
await coord.start()
const turn = await coord.acquireTurn(await coord.reserve(key))
process.stdout.write(`held ${turn.fence}\n`)
setInterval(() => {}, 60_000)
