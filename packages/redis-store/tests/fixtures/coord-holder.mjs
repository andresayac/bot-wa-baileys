// Child process for the failover integration test: joins as replica "dying", takes the
// turn of `key` and holds it until the parent kills this process (no cleanup runs).
// Usage: node coord-holder.mjs <redisUrl> <prefix> <key> <leaseMs>
import { RedisCoordinator } from '../../lib/index.js'

const [url, prefix, key, leaseMs] = process.argv.slice(2)
const coord = new RedisCoordinator({ url, prefix, replicaId: 'dying', leaseMs: Number(leaseMs) })
await coord.start()
const turn = await coord.acquireTurn(await coord.reserve(key))
process.stdout.write(`held ${turn.fence}\n`)
setInterval(() => {}, 60_000)
