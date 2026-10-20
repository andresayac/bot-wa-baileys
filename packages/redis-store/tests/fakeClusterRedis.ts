/**
 * Fakes for the cluster key layout (hermetic; fakeRedis.ts is left untouched).
 *
 * - {@link LayoutFakeRedisClient}: the single-node fake plus the cluster-layout scripts
 *   (clusterScripts.ts), so the cluster layout can run on "one node" exactly like the
 *   in-place migration does. KEYS only.
 * - {@link ScanningLayoutFakeRedisClient}: the same with node-redis' `scanIterator`
 *   (honouring `TYPE`).
 * - {@link ClusterFakeRedisClient}: a Redis Cluster as node-redis exposes it: detected by
 *   `masters` + `nodeClient`, no whole-keyspace `KEYS`/`SCAN`, and every multi-key
 *   command, MULTI and EVAL rejected with Redis' exact CROSSSLOT error when its keys span
 *   several hash slots. Scripts that build key names inside Lua (legacy TURN_SCRIPT and
 *   DELETE_CHAT_SCRIPT) are rejected outright. `failNext()` injects TRYAGAIN replies.
 */
import type { RedisLikeClient, RedisMulti } from '../src/RedisStore.js'
import {
  CAS_CHECKPOINT_INDEXED_SCRIPT, CAS_INDEXED_SCRIPT, CLEAR_CHECKPOINT_IF_INDEXED_SCRIPT, DELETE_BATCH_SCRIPT, DEL_INDEXED_SCRIPT,
  DROP_MESSAGES_SCRIPT, LIVE_INDEX_SCRIPT,
  MAX_COUNTER_SCRIPT, PROBE_EXISTS_SCRIPT, READ_WITH_TTL_SCRIPT, SAVE_MESSAGE_SCRIPT, ZRANGE_RAW_SCRIPT,
} from '../src/clusterScripts.js'
import { DELETE_CHAT_SCRIPT } from '../src/scripts.js'
import { TURN_SCRIPT } from '../src/coordScripts.js'
import { hashSlot } from '../src/slot.js'
import { FakeRedisClient, jsonRevision, stringMatch } from './fakeRedis.js'
import { evalClusterCoordScript } from './fakeClusterScripts.js'

export const CROSSSLOT = "CROSSSLOT Keys in request don't hash to the same slot"

/** The base fake's synchronous (atomic) helpers, reached through a cast: they are TS-private there. */
interface FakeInternals {
  live(key: string): boolean
  readString(key: string): string | null
  readZset(key: string): Map<string, number> | undefined
  setSync(key: string, value: string, options?: { NX?: true; XX?: true; EX?: number; PX?: number }): string | null
  delSync(key: string | string[]): number
  zAddSync(key: string, members: { score: number; value: string } | Array<{ score: number; value: string }>, options?: { NX?: true; XX?: true }): number
  zRemSync(key: string, member: string | string[]): number
}

export class LayoutFakeRedisClient extends FakeRedisClient {
  /** Every EVAL received, by script text (lets tests assert which scripts ran). */
  readonly evals: string[] = []

  protected get x(): FakeInternals {
    return this as unknown as FakeInternals
  }

  override async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    this.evals.push(script)
    const keys = options?.keys ?? []
    const args = options?.arguments ?? []
    const coord = evalClusterCoordScript(this.coord, script, keys, args)
    if (coord !== undefined) return coord
    const x = this.x
    switch (script) {
      case CAS_INDEXED_SCRIPT: {
        const [record, index] = keys as [string, string]
        const [mode, expected, next, member, px] = args as [string, string, string, string, string]
        const cur = x.readString(record)
        if (mode === '0' ? cur !== null : mode === '1' ? cur !== expected : false) return 0
        if (px !== '') {
          x.setSync(record, next, { PX: Number(px) })
          x.zAddSync(index, { score: Date.now() + Number(px), value: member })
        } else {
          x.setSync(record, next)
          x.zAddSync(index, { score: Number.POSITIVE_INFINITY, value: member })
        }
        return 1
      }
      case DEL_INDEXED_SCRIPT: {
        const [record, index] = keys as [string, string]
        const n = x.delSync(record)
        x.zRemSync(index, args[0]!)
        return n
      }
      case CAS_CHECKPOINT_INDEXED_SCRIPT: {
        const [record, index] = keys as [string, string]
        const [expected, next, member, px] = args as [string, string, string, string]
        if (jsonRevision(x.readString(record)) !== Number(expected)) return 0
        if (px !== '') {
          x.setSync(record, next, { PX: Number(px) })
          x.zAddSync(index, { score: Date.now() + Number(px), value: member })
        } else {
          x.setSync(record, next)
          x.zAddSync(index, { score: Number.POSITIVE_INFINITY, value: member })
        }
        return 1
      }
      case CLEAR_CHECKPOINT_IF_INDEXED_SCRIPT: {
        const [record, index] = keys as [string, string]
        const [expected, member] = args as [string, string]
        const cur = x.readString(record)
        if (cur === null) { x.zRemSync(index, member); return 1 }
        if (jsonRevision(cur) !== Number(expected)) return 0
        x.delSync(record)
        x.zRemSync(index, member)
        return 1
      }
      case DROP_MESSAGES_SCRIPT: {
        let n = 0
        args.forEach((member, i) => {
          if (x.zRemSync(keys[0]!, member) === 1) {
            x.delSync(keys[i + 1]!)
            n++
          }
        })
        return n
      }
      case LIVE_INDEX_SCRIPT: {
        const set = x.readZset(keys[0]!)
        if (!set) return []
        const now = Date.now()
        for (const [m, score] of [...set]) if (score <= now) x.zRemSync(keys[0]!, m)
        return this.zRange(keys[0]!, 0, -1)
      }
      case DELETE_BATCH_SCRIPT: {
        let n = 0
        args.forEach((member, i) => {
          n += x.delSync(keys[i + 1]!)
          x.zRemSync(keys[0]!, member)
        })
        return n
      }
      case PROBE_EXISTS_SCRIPT: {
        const key = keys[0]!
        return this.coord.exists(key) || (x.live(key) && (this.strings.has(key) || this.zsets.has(key))) ? 1 : 0
      }
      case READ_WITH_TTL_SCRIPT: {
        const key = keys[0]!
        x.live(key)
        if (!this.strings.has(key) && !this.zsets.has(key)) return [null, -2]
        const at = this.expires.get(key)
        return [this.strings.get(key) ?? null, at === undefined ? -1 : Math.max(1, at - Date.now())]
      }
      case SAVE_MESSAGE_SCRIPT: {
        x.setSync(keys[0]!, args[0]!)
        x.zAddSync(keys[1]!, { score: Number(args[1]), value: args[2]! })
        return 1
      }
      case ZRANGE_RAW_SCRIPT: {
        const entries = await this.zRangeWithScores(keys[0]!, 0, -1)
        const fmt = (n: number) => (n === Number.POSITIVE_INFINITY ? 'inf' : n === Number.NEGATIVE_INFINITY ? '-inf' : String(n))
        return entries.flatMap((e) => [e.value, fmt(e.score)])
      }
      case MAX_COUNTER_SCRIPT: {
        const c = Number(x.readString(keys[0]!) ?? '0')
        const v = Number(args[0])
        if (v > c) {
          x.setSync(keys[0]!, args[0]!)
          return v
        }
        return c
      }
      default:
        return super.eval(script, options)
    }
  }

  /** PTTL of a key (test helper): -2 absent, -1 no expiry. */
  pttl(key: string): number {
    if (!this.x.live(key) || !(this.strings.has(key) || this.zsets.has(key))) return -2
    const at = this.expires.get(key)
    return at === undefined ? -1 : at - Date.now()
  }

  /** The type of a live key ('none' when absent). */
  typeOf(key: string): 'string' | 'zset' | 'none' {
    if (!this.x.live(key)) return 'none'
    return this.strings.has(key) ? 'string' : this.zsets.has(key) ? 'zset' : 'none'
  }

  /** Live keys matching a glob (test helper, no KEYS accounting). */
  keysMatching(pattern: string): string[] {
    return this.matching(pattern)
  }
}

export class ScanningLayoutFakeRedisClient extends LayoutFakeRedisClient {
  async *scanIterator(options?: { MATCH?: string; COUNT?: number; TYPE?: string }): AsyncIterable<string | string[]> {
    const keys = this.matching(options?.MATCH ?? '*').filter((k) => !options?.TYPE || this.typeOf(k) === options.TYPE)
    for (let i = 0; i < keys.length; i += 3) yield keys.slice(i, i + 3)
  }
}

/** A node of the cluster fake as `nodeClient()` returns it: whole-node KEYS/SCAN. */
class FakeNodeClient {
  constructor(private readonly owner: ClusterFakeRedisClient) {}
  async keys(pattern: string): Promise<string[]> { return this.owner.keysMatching(pattern) }
  async *scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string[]> {
    yield this.owner.keysMatching(options?.MATCH ?? '*')
  }
  async get(key: string): Promise<string | null> { return this.owner.get(key) }
  async del(key: string | string[]): Promise<number> { return this.owner.del(key) }
}

export class ClusterFakeRedisClient extends LayoutFakeRedisClient {
  /** node-redis cluster shape: auto-detected by the store. One "master" holds every slot. */
  readonly masters = [{ id: 'fake-master', host: '127.0.0.1', port: 0 }]
  private injected: { left: number; message: string } = { left: 0, message: '' }
  /** Commands rejected by {@link failNext} so far. */
  rejected = 0

  nodeClient(): FakeNodeClient {
    return new FakeNodeClient(this)
  }

  /** Reject the next `n` multi-key commands (EVAL / EXEC / multi-key DEL) with `message` (default TRYAGAIN). */
  failNext(n: number, message = 'TRYAGAIN Multiple keys request during rehashing of slot'): void {
    this.injected = { left: n, message }
  }

  private maybeFail(): void {
    if (this.injected.left > 0) {
      this.injected.left--
      this.rejected++
      throw new Error(this.injected.message)
    }
  }

  private checkSlots(keys: string[]): void {
    if (keys.length < 2) return
    const s = hashSlot(keys[0]!)
    if (keys.some((k) => hashSlot(k) !== s)) throw new Error(CROSSSLOT)
  }

  /** node-redis cluster `sendCommand(firstKey, isReadonly, args)`: only EVAL is modelled. */
  async sendCommand(_firstKey: string | undefined, _readonly: boolean | undefined, args: string[]): Promise<unknown> {
    if (args[0] !== 'EVAL') throw new Error(`ClusterFakeRedisClient: sendCommand ${String(args[0])} is not modelled`)
    const n = Number(args[2])
    return this.eval(args[1]!, { keys: args.slice(3, 3 + n), arguments: args.slice(3 + n) })
  }

  override async keys(_pattern?: string): Promise<string[]> {
    throw new Error('ClusterFakeRedisClient: KEYS is not routable on a cluster client (it would only see one node)')
  }

  override async del(key: string | string[]): Promise<number> {
    if (Array.isArray(key) && key.length > 1) {
      this.maybeFail()
      this.checkSlots(key)
    }
    return super.del(key)
  }

  override async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    if (script === TURN_SCRIPT || script === DELETE_CHAT_SCRIPT) {
      throw new Error('ERR Script attempted to access a non local key in a cluster node (key built inside the script)')
    }
    this.maybeFail()
    this.checkSlots(options?.keys ?? [])
    return super.eval(script, options)
  }

  override multi(): RedisMulti {
    const inner = super.multi()
    const keys: string[] = []
    const tx: RedisMulti = {
      set: (key, value, o) => { keys.push(key); inner.set(key, value, o); return tx },
      del: (key) => { keys.push(...(Array.isArray(key) ? key : [key])); inner.del(key); return tx },
      zAdd: (key, members, o) => { keys.push(key); inner.zAdd(key, members, o); return tx },
      zRem: (key, member) => { keys.push(key); inner.zRem(key, member); return tx },
      exec: async () => {
        this.maybeFail()
        this.checkSlots(keys)
        return inner.exec()
      },
    }
    return tx
  }
}

/** Type guard used by tests that accept either fake. */
export function isLayoutFake(c: RedisLikeClient): c is LayoutFakeRedisClient {
  return c instanceof LayoutFakeRedisClient
}

export { stringMatch }
