/**
 * In-memory model of TURN_CLUSTER_SCRIPT (clusterScripts.ts) on top of the coordinator
 * fake state, mirroring the Lua line by line. The cluster integration suite runs the
 * real script against a real Redis Cluster, so the two cannot drift silently.
 */
import { TURN_CLUSTER_SCRIPT } from '../src/clusterScripts.js'
import type { FakeCoordState } from './fakeCoordScripts.js'

/** Run the cluster turn script, or return `undefined` when `script` is not it. */
export function evalClusterCoordScript(s: FakeCoordState, script: string, keys: string[], args: string[]): unknown {
  if (script !== TURN_CLUSTER_SCRIPT) return undefined
  const [servingK, ownerK, tixK, lastK] = keys as [string, string, string, string]
  const [seqArg, rid, leaseMs, ...deadList] = args as [string, string, string, ...string[]]
  const dead = new Set(deadList)
  const seq = Number(seqArg)
  for (let i = 0; i < 1000; i++) {
    const raw = s.get(servingK)
    if (raw === null) return [-1, '']
    const cur = Number(raw)
    if (cur > seq) return [-1, '']
    if (cur === seq) {
      if (s.hget(tixK, seqArg) !== rid) return [-1, '']
      const mine = `${seqArg}|${rid}`
      const o = s.get(ownerK)
      if (o !== null && o !== mine) return [0, '']
      s.set(ownerK, mine, Number(leaseMs))
      return [1, s.get(lastK) ?? '']
    }
    const h = s.hget(tixK, String(cur))
    if (h !== null) {
      if (s.get(ownerK) === `${cur}|${h}`) return [0, '']
      if (!dead.has(h)) return [2, h]
      s.hdel(tixK, String(cur))
      s.set(lastK, h)
    }
    s.incr(servingK)
  }
  return [0, '']
}
