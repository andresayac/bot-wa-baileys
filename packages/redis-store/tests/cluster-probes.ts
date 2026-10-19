/**
 * Behaviour probes for the cluster key layout, run against the cluster fake
 * (cluster-fake.test.ts) AND a real Redis Cluster (cluster.integration.test.ts), so the
 * fake cannot drift from what a real cluster does.
 */
import { isDeepStrictEqual } from 'node:util'
import type { RedisLikeClient } from '../src/RedisStore.js'
import {
  CAS_INDEXED_SCRIPT, DEL_INDEXED_SCRIPT, DROP_MESSAGES_SCRIPT, LIVE_INDEX_SCRIPT, PROBE_EXISTS_SCRIPT, TURN_CLUSTER_SCRIPT, ZRANGE_RAW_SCRIPT,
} from '../src/clusterScripts.js'
import { HEARTBEAT_SCRIPT, RESERVE_SCRIPT } from '../src/coordScripts.js'
import { hashSlot } from '../src/slot.js'

export interface ClusterProbe {
  name: string
  /** `ns` is a unique namespace without braces. */
  run: (c: RedisLikeClient, ns: string) => Promise<unknown>
  /** Expected value, or `{ error }` matched against the rejection message. */
  expected: unknown
}

/** Two keys guaranteed to live in different slots. */
function twoSlots(ns: string): [string, string] {
  const a = `{${ns}-a}x`
  for (let i = 0; ; i++) {
    const b = `{${ns}-b${i}}x`
    if (hashSlot(a) !== hashSlot(b)) return [a, b]
  }
}

const tag = (ns: string, name: string) => `{${ns}}:${name}`

export const CLUSTER_PROBES: ClusterProbe[] = [
  {
    name: 'a multi-key DEL across slots is rejected',
    run: async (c, ns) => c.del(twoSlots(ns)),
    expected: { error: /CROSSSLOT/ },
  },
  {
    name: 'an EVAL whose keys span slots is rejected',
    run: async (c, ns) => c.eval(DEL_INDEXED_SCRIPT, { keys: twoSlots(ns), arguments: ['m'] }),
    expected: { error: /CROSSSLOT/ },
  },
  {
    name: 'a MULTI across slots is rejected',
    run: async (c, ns) => {
      const [a, b] = twoSlots(ns)
      return c.multi().set(a, '1').set(b, '1').exec()
    },
    expected: { error: /CROSSSLOT|EXECABORT|MOVED/ },
  },
  {
    name: 'a MULTI inside one slot commits',
    run: async (c, ns) => {
      await c.multi().set(tag(ns, 'i'), 'v').zAdd(tag(ns, 'z'), { score: 1, value: 'm' }).exec()
      return [await c.get(tag(ns, 'i')), await c.zRange(tag(ns, 'z'), 0, -1)]
    },
    expected: ['v', ['m']],
  },
  {
    name: 'CAS_INDEXED: absent-only write, then compare, index score +inf without PX',
    run: async (c, ns) => {
      const r = tag(ns, 'r'), idx = tag(ns, 'idx')
      const first = await c.eval(CAS_INDEXED_SCRIPT, { keys: [r, idx], arguments: ['0', '', 'v1', 'id', ''] })
      const again = await c.eval(CAS_INDEXED_SCRIPT, { keys: [r, idx], arguments: ['0', '', 'v2', 'id', ''] })
      const stale = await c.eval(CAS_INDEXED_SCRIPT, { keys: [r, idx], arguments: ['1', 'nope', 'v3', 'id', ''] })
      const ok = await c.eval(CAS_INDEXED_SCRIPT, { keys: [r, idx], arguments: ['1', 'v1', 'v4', 'id', ''] })
      // Raw scores: node-redis 4 parses 'inf' to NaN.
      const scores = await c.eval(ZRANGE_RAW_SCRIPT, { keys: [idx] })
      return [Number(first), Number(again), Number(stale), Number(ok), await c.get(r), scores]
    },
    expected: [1, 0, 0, 1, 'v4', ['id', 'inf']],
  },
  {
    name: 'CAS_INDEXED with PX scores the server expiry and LIVE_INDEX prunes past entries',
    run: async (c, ns) => {
      const r = tag(ns, 'r'), idx = tag(ns, 'idx')
      await c.eval(CAS_INDEXED_SCRIPT, { keys: [r, idx], arguments: ['*', '', 'v', 'live', '600000'] })
      await c.zAdd(idx, { score: 1, value: 'old' })
      const score = (await c.zRangeWithScores(idx, 0, -1)).find((e) => e.value === 'live')!.score
      const members = (await c.eval(LIVE_INDEX_SCRIPT, { keys: [idx] })) as string[]
      return [score > Date.now() + 590_000 && score < Date.now() + 610_000, members]
    },
    expected: [true, ['live']],
  },
  {
    name: 'DROP_MESSAGES only drops members of the log',
    run: async (c, ns) => {
      const z = tag(ns, 'z')
      await c.multi().set(tag(ns, 'i:a'), '1').set(tag(ns, 'i:b'), '1').zAdd(z, { score: 1, value: 'a' }).exec()
      const n = await c.eval(DROP_MESSAGES_SCRIPT, { keys: [z, tag(ns, 'i:a'), tag(ns, 'i:b')], arguments: ['a', 'b'] })
      return [Number(n), await c.get(tag(ns, 'i:a')), await c.get(tag(ns, 'i:b'))]
    },
    expected: [1, null, '1'],
  },
  {
    name: 'TURN_CLUSTER reports an earlier live-unknown holder, skips it once listed dead',
    run: async (c, ns) => {
      const k = { seq: tag(ns, 'seq'), tix: tag(ns, 'tix'), serving: tag(ns, 'serving'), owner: tag(ns, 'owner'), last: tag(ns, 'last') }
      await c.eval(RESERVE_SCRIPT, { keys: [k.seq, k.tix, k.serving, k.last], arguments: ['h1'] })
      await c.eval(RESERVE_SCRIPT, { keys: [k.seq, k.tix, k.serving, k.last], arguments: ['me'] })
      const unknown = await c.eval(TURN_CLUSTER_SCRIPT, { keys: [k.serving, k.owner, k.tix, k.last], arguments: ['2', 'me', '5000'] })
      const granted = await c.eval(TURN_CLUSTER_SCRIPT, { keys: [k.serving, k.owner, k.tix, k.last], arguments: ['2', 'me', '5000', 'h1'] })
      return [unknown, granted]
    },
    expected: [[2, 'h1'], [1, 'h1']],
  },
  {
    name: 'PROBE_EXISTS sees a heartbeat and its absence',
    run: async (c, ns) => {
      const hb = `${ns}:co:rep:x`
      const before = await c.eval(PROBE_EXISTS_SCRIPT, { keys: [hb] })
      await c.eval(HEARTBEAT_SCRIPT, { keys: [hb], arguments: ['5000'] })
      const after = await c.eval(PROBE_EXISTS_SCRIPT, { keys: [hb] })
      return [Number(before), Number(after)]
    },
    expected: [0, 1],
  },
]

/** Normalize a probe's outcome for comparison. */
export async function probeOutcome(probe: ClusterProbe, c: RedisLikeClient, ns: string): Promise<unknown> {
  try {
    return await probe.run(c, ns)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export function probeMeets(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && 'error' in expected && (expected as { error: unknown }).error instanceof RegExp) {
    const a = actual as { error?: unknown }
    return typeof a?.error === 'string' && (expected as { error: RegExp }).error.test(a.error)
  }
  return isDeepStrictEqual(actual, expected)
}
