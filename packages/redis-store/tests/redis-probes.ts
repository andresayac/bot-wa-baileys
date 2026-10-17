/**
 * Behaviour probes shared by the hermetic fake tests (fakeRedis.test.ts) and
 * the real-server suite (integration.test.ts): every probe states what REAL
 * Redis replies, so the fake is checked against the same expectations a live
 * server is verified to meet.
 *
 * Each probe gets a client and `k(name)`, which namespaces a key; `glob(name)`
 * is the same namespace glob-escaped, for KEYS patterns.
 */
import type { RedisLikeClient } from '../src/RedisStore.js'
import { MERGE_CAS_SCRIPT, RELEASE_LOCK_SCRIPT } from '../src/scripts.js'

export interface ProbeTools {
  k: (name: string) => string
  /** Namespace prefix, glob-escaped, to prepend to a KEYS pattern. */
  ns: string
}

export interface Probe {
  name: string
  run: (c: RedisLikeClient, t: ProbeTools) => Promise<unknown>
  /** Expected resolved value, or `{ error }` matched against the rejection message. */
  expected: unknown
}

const err = (pattern: RegExp): { error: RegExp } => ({ error: pattern })

/** Run a probe and normalize its outcome for comparison with `expected`. */
export async function outcome(probe: Probe, c: RedisLikeClient, t: ProbeTools): Promise<unknown> {
  try {
    return await probe.run(c, t)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** True when `actual` (from {@link outcome}) meets `expected`. */
export function meets(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && 'error' in expected && (expected as { error: unknown }).error instanceof RegExp) {
    const a = actual as { error?: unknown }
    return typeof a?.error === 'string' && (expected as { error: RegExp }).error.test(a.error)
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

/** KEYS with the namespace stripped and the result sorted. */
async function keysUnder(c: RedisLikeClient, t: ProbeTools, pattern: string): Promise<string[]> {
  const prefix = t.k('')
  return (await c.keys(t.ns + pattern)).map((key) => key.slice(prefix.length)).sort()
}

async function seed(c: RedisLikeClient, t: ProbeTools, names: string[]): Promise<void> {
  for (const name of names) await c.set(t.k(name), '1')
}

async function zseed(c: RedisLikeClient, t: ProbeTools, key: string): Promise<void> {
  await c.zAdd(t.k(key), [
    { score: 10, value: 'a' },
    { score: 20, value: 'b' },
    { score: 30, value: 'c' },
    { score: 40, value: 'd' },
  ])
}

export const PROBES: Probe[] = [
  /* KEYS glob semantics ---------------------------------------------------- */
  {
    name: 'KEYS: backslash escapes "*" and "?" literally',
    run: async (c, t) => {
      await seed(c, t, ['g1:a*b', 'g1:axb', 'g1:a?b'])
      return [await keysUnder(c, t, 'g1:a\\*b'), await keysUnder(c, t, 'g1:a\\?b'), await keysUnder(c, t, 'g1:a?b')]
    },
    expected: [['g1:a*b'], ['g1:a?b'], ['g1:a*b', 'g1:a?b', 'g1:axb']],
  },
  {
    name: 'KEYS: "[1]" is a class, "\\[1\\]" is literal brackets',
    run: async (c, t) => {
      await seed(c, t, ['g2:bot1:x', 'g2:bot[1]:x'])
      return [await keysUnder(c, t, 'g2:bot[1]:*'), await keysUnder(c, t, 'g2:bot\\[1\\]:*')]
    },
    expected: [['g2:bot1:x'], ['g2:bot[1]:x']],
  },
  {
    name: 'KEYS: ranges, reversed ranges, negation and escapes inside a class',
    run: async (c, t) => {
      await seed(c, t, ['g3:ax', 'g3:bx', 'g3:dx', 'g3:]x', 'g3:-x'])
      return [
        await keysUnder(c, t, 'g3:[a-c]x'),
        await keysUnder(c, t, 'g3:[c-a]x'),
        await keysUnder(c, t, 'g3:[^a-c]x'),
        await keysUnder(c, t, 'g3:[\\]]x'),
        await keysUnder(c, t, 'g3:[a\\-c]x'),
      ]
    },
    expected: [['g3:ax', 'g3:bx'], ['g3:ax', 'g3:bx'], ['g3:-x', 'g3:]x', 'g3:dx'], ['g3:]x'], ['g3:-x', 'g3:ax']],
  },
  {
    name: 'KEYS: "?" matches one BYTE (a 2-byte UTF-8 char needs "??")',
    run: async (c, t) => {
      await seed(c, t, ['g4:ñ'])
      return [await keysUnder(c, t, 'g4:?'), await keysUnder(c, t, 'g4:??')]
    },
    expected: [[], ['g4:ñ']],
  },
  {
    name: 'KEYS: an unterminated class still matches as a class',
    run: async (c, t) => {
      await seed(c, t, ['g5:a', 'g5:b'])
      return keysUnder(c, t, 'g5:[ab')
    },
    expected: ['g5:a', 'g5:b'],
  },

  /* ZRANGE ----------------------------------------------------------------- */
  {
    name: 'ZRANGE without BY takes rank indices (negative from the end)',
    run: async (c, t) => {
      await zseed(c, t, 'z1')
      const key = t.k('z1')
      return [
        await c.zRange(key, 0, -1),
        await c.zRange(key, 1, 2),
        await c.zRange(key, -2, -1),
        await c.zRange(key, 0, 0, { REV: true }),
        await c.zRange(key, 5, 10),
      ]
    },
    expected: [['a', 'b', 'c', 'd'], ['b', 'c'], ['c', 'd'], ['d'], []],
  },
  {
    name: 'ZRANGE by rank rejects a non-integer index',
    run: async (c, t) => {
      await zseed(c, t, 'z2')
      return c.zRange(t.k('z2'), 0, 1.5)
    },
    expected: err(/not an integer/),
  },
  {
    name: 'ZRANGE BYSCORE: inclusive/exclusive bounds and REV swaps the bound order',
    run: async (c, t) => {
      await zseed(c, t, 'z3')
      const key = t.k('z3')
      return [
        await c.zRange(key, 20, 30, { BY: 'SCORE' }),
        await c.zRange(key, '(20', '+inf', { BY: 'SCORE' }),
        await c.zRange(key, '+inf', '(30', { BY: 'SCORE', REV: true }),
      ]
    },
    expected: [['b', 'c'], ['c', 'd'], ['d']],
  },
  {
    name: 'ZRANGE LIMIT: a negative count means "all the rest"; a negative offset yields nothing',
    run: async (c, t) => {
      await zseed(c, t, 'z4')
      const key = t.k('z4')
      return [
        await c.zRange(key, '-inf', '+inf', { BY: 'SCORE', LIMIT: { offset: 1, count: -1 } }),
        await c.zRange(key, '-inf', '+inf', { BY: 'SCORE', LIMIT: { offset: -1, count: 2 } }),
      ]
    },
    expected: [['b', 'c', 'd'], []],
  },
  {
    name: 'ZRANGE LIMIT rejects a fractional count',
    run: async (c, t) => {
      await zseed(c, t, 'z5')
      return c.zRange(t.k('z5'), '-inf', '+inf', { BY: 'SCORE', LIMIT: { offset: 0, count: 2.5 } })
    },
    expected: err(/not an integer/),
  },
  {
    name: 'ZRANGE LIMIT rejects an infinite count',
    run: async (c, t) => {
      await zseed(c, t, 'z6')
      return c.zRange(t.k('z6'), '-inf', '+inf', { BY: 'SCORE', LIMIT: { offset: 0, count: Infinity } })
    },
    expected: err(/not an integer/),
  },
  {
    name: 'ZRANGE LIMIT without BYSCORE/BYLEX is a syntax error',
    run: async (c, t) => {
      await zseed(c, t, 'z7')
      return c.zRange(t.k('z7'), 0, -1, { LIMIT: { offset: 0, count: 1 } })
    },
    expected: err(/syntax error/),
  },

  /* SET expiry validation -------------------------------------------------- */
  ...([
    ['EX 0', { EX: 0 }],
    ['EX -1', { EX: -1 }],
    ['EX 1.5', { EX: 1.5 }],
    ['PX 0', { PX: 0 }],
    ['PX 2.5', { PX: 2.5 }],
    ['PX Infinity', { PX: Infinity }],
  ] as const).map(([label, options]): Probe => ({
    name: `SET ${label} is rejected`,
    run: (c, t) => c.set(t.k(`ex:${label}`), 'v', options),
    expected: err(/invalid expire time|not an integer/),
  })),
  {
    name: 'SET with a positive integer PX is accepted',
    run: (c, t) => c.set(t.k('ex:ok'), 'v', { PX: 60_000 }),
    expected: 'OK',
  },

  /* Type checks ------------------------------------------------------------ */
  {
    name: 'WRONGTYPE: ZADD on a string key',
    run: async (c, t) => {
      await c.set(t.k('wt1'), 'v')
      return c.zAdd(t.k('wt1'), { score: 1, value: 'm' })
    },
    expected: err(/^WRONGTYPE/),
  },
  {
    name: 'WRONGTYPE: GET on a sorted-set key',
    run: async (c, t) => {
      await c.zAdd(t.k('wt2'), { score: 1, value: 'm' })
      return c.get(t.k('wt2'))
    },
    expected: err(/^WRONGTYPE/),
  },
  {
    name: 'WRONGTYPE: ZCARD / ZRANGE / ZREM on a string key',
    run: async (c, t) => {
      await c.set(t.k('wt3'), 'v')
      const out: string[] = []
      for (const call of [() => c.zCard(t.k('wt3')), () => c.zRange(t.k('wt3'), 0, -1), () => c.zRem(t.k('wt3'), 'm')]) {
        try {
          await call()
          out.push('ok')
        } catch (e) {
          out.push((e as Error).message.split(' ')[0] ?? '')
        }
      }
      return out
    },
    expected: ['WRONGTYPE', 'WRONGTYPE', 'WRONGTYPE'],
  },
  {
    name: 'SET over a sorted-set key replaces it with a string',
    run: async (c, t) => {
      await c.zAdd(t.k('wt4'), { score: 1, value: 'm' })
      await c.set(t.k('wt4'), 'v')
      return c.get(t.k('wt4'))
    },
    expected: 'v',
  },

  /* MULTI ------------------------------------------------------------------ */
  {
    name: 'MULTI: a failing command does not roll back the others, and exec rejects',
    run: async (c, t) => {
      await c.set(t.k('mx:str'), 'v')
      let failed = false
      try {
        await c.multi().set(t.k('mx:a'), '1').zAdd(t.k('mx:str'), { score: 1, value: 'm' }).set(t.k('mx:b'), '2').exec()
      } catch {
        failed = true
      }
      return [failed, await c.get(t.k('mx:a')), await c.get(t.k('mx:b'))]
    },
    expected: [true, '1', '2'],
  },

  /* EVAL: the scripts the store sends ------------------------------------- */
  {
    name: 'EVAL release-lock: deletes only on a matching token',
    run: async (c, t) => {
      await c.set(t.k('lk'), 'tok')
      const wrong = await c.eval(RELEASE_LOCK_SCRIPT, { keys: [t.k('lk')], arguments: ['nope'] })
      const right = await c.eval(RELEASE_LOCK_SCRIPT, { keys: [t.k('lk')], arguments: ['tok'] })
      return [wrong, right, await c.get(t.k('lk'))]
    },
    expected: [0, 1, null],
  },
  {
    name: 'EVAL merge-cas: writes only when the value is still the expected one',
    run: async (c, t) => {
      const key = t.k('cas')
      const cas = (args: string[]): Promise<unknown> => c.eval(MERGE_CAS_SCRIPT, { keys: [key], arguments: args })
      const created = await cas(['0', '', 'v1'])
      const createdAgain = await cas(['0', '', 'other'])
      const stale = await cas(['1', 'v0', 'other'])
      const swapped = await cas(['1', 'v1', 'v2'])
      return [created, createdAgain, stale, swapped, await c.get(key)]
    },
    expected: [1, 0, 0, 1, 'v2'],
  },
  {
    name: 'EVAL merge-cas against a missing key with an expected value is a conflict',
    run: async (c, t) => [
      await c.eval(MERGE_CAS_SCRIPT, { keys: [t.k('cas2')], arguments: ['1', 'v', 'w'] }),
      await c.get(t.k('cas2')),
    ],
    expected: [0, null],
  },
]
