/**
 * In-memory fake of the node-redis v4 client surface used by RedisStore.
 *
 * Hermetic: no network, no real Redis. Expiry is lazy (checked on access)
 * and deterministic — tests can force a key to expire by rewriting its entry
 * in {@link FakeRedisClient.expires}. `eval` implements the ONE script the
 * store sends (the Lua compare-and-delete lock release).
 */
import type { RedisLikeClient, RedisMulti, RedisZRangeOptions } from '../src/RedisStore.js'

interface ZEntry {
  score: number
  value: string
}

function bound(v: number | string): number {
  if (typeof v === 'number') return v
  if (v === '+inf' || v === 'inf' || v === '+Infinity' || v === 'Infinity') return Number.POSITIVE_INFINITY
  if (v === '-inf' || v === '-Infinity') return Number.NEGATIVE_INFINITY
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`FakeRedisClient: unsupported ZRANGE bound: ${v}`)
  return n
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export class FakeRedisClient implements RedisLikeClient {
  readonly strings = new Map<string, string>()
  readonly zsets = new Map<string, Map<string, number>>()
  /** key -> epoch ms at which the key becomes expired. Rewrite to simulate expiry. */
  readonly expires = new Map<string, number>()
  isOpen = false

  /** Purge the key if its deadline passed; false when the key is gone/expired. */
  private live(key: string): boolean {
    const at = this.expires.get(key)
    if (at != null && Date.now() >= at) {
      this.strings.delete(key)
      this.zsets.delete(key)
      this.expires.delete(key)
      return false
    }
    return true
  }

  async connect(): Promise<unknown> {
    this.isOpen = true
    return this
  }
  async quit(): Promise<string> {
    this.isOpen = false
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    this.live(key)
    return this.strings.get(key) ?? null
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: true; XX?: true; EX?: number; PX?: number },
  ): Promise<string | null> {
    this.live(key)
    const exists = this.strings.has(key)
    if (options?.NX && exists) return null
    if (options?.XX && !exists) return null
    this.strings.set(key, value)
    if (options?.PX != null) this.expires.set(key, Date.now() + options.PX)
    else if (options?.EX != null) this.expires.set(key, Date.now() + options.EX * 1000)
    else this.expires.delete(key)
    return 'OK'
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key]
    let removed = 0
    for (const k of keys) {
      if (this.strings.delete(k)) removed++
      if (this.zsets.delete(k)) removed++
      this.expires.delete(k)
    }
    return removed
  }

  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern)
    const out: string[] = []
    for (const k of new Set([...this.strings.keys(), ...this.zsets.keys()])) {
      this.live(k)
      if ((this.strings.has(k) || this.zsets.has(k)) && re.test(k)) out.push(k)
    }
    return out
  }

  async zAdd(
    key: string,
    members: ZEntry | ZEntry[],
    options?: { NX?: true; XX?: true },
  ): Promise<number> {
    const list = Array.isArray(members) ? members : [members]
    let set = this.zsets.get(key)
    if (!set) {
      set = new Map()
      this.zsets.set(key, set)
    }
    let added = 0
    for (const m of list) {
      const exists = set.has(m.value)
      if (options?.NX && exists) continue
      if (options?.XX && !exists) continue
      if (!exists) added++
      set.set(m.value, m.score)
    }
    return added
  }

  private sorted(key: string, rev: boolean): ZEntry[] {
    const set = this.zsets.get(key)
    if (!set) return []
    const entries = [...set.entries()].map(([value, score]) => ({ score, value }))
    entries.sort((a, b) => a.score - b.score || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    if (rev) entries.reverse()
    return entries
  }

  async zRange(
    key: string,
    min: number | string,
    max: number | string,
    options?: RedisZRangeOptions,
  ): Promise<string[]> {
    return (await this.zRangeWithScores(key, min, max, options)).map((e) => e.value)
  }

  async zRangeWithScores(
    key: string,
    min: number | string,
    max: number | string,
    options?: RedisZRangeOptions,
  ): Promise<ZEntry[]> {
    if (options?.BY && options.BY !== 'SCORE') {
      throw new Error('FakeRedisClient only supports ZRANGE BY SCORE')
    }
    const rev = options?.REV === true
    // REV swaps the bound order: the first argument is then the MAX bound.
    const lo = bound(rev ? max : min)
    const hi = bound(rev ? min : max)
    let entries = this.sorted(key, rev).filter((e) => e.score >= lo && e.score <= hi)
    if (options?.LIMIT) {
      entries = entries.slice(options.LIMIT.offset, options.LIMIT.offset + options.LIMIT.count)
    }
    return entries
  }

  async zRem(key: string, member: string | string[]): Promise<number> {
    const set = this.zsets.get(key)
    if (!set) return 0
    const members = Array.isArray(member) ? member : [member]
    let removed = 0
    for (const m of members) if (set.delete(m)) removed++
    return removed
  }

  async zCard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0
  }

  /**
   * MULTI — queue commands and apply them on exec(). The fake is single-threaded
   * so sequential application on exec() is atomic enough to model a transaction.
   */
  multi(): RedisMulti {
    const ops: Array<() => Promise<unknown>> = []
    const tx: RedisMulti = {
      set: (key, value, options) => { ops.push(() => this.set(key, value, options)); return tx },
      del: (key) => { ops.push(() => this.del(key)); return tx },
      zAdd: (key, members, options) => { ops.push(() => this.zAdd(key, members, options)); return tx },
      zRem: (key, member) => { ops.push(() => this.zRem(key, member)); return tx },
      exec: async () => {
        const results: unknown[] = []
        for (const op of ops) results.push(await op())
        return results
      },
    }
    return tx
  }

  /** Implements the single script RedisStore sends: Lua compare-and-delete. */
  async eval(_script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<number> {
    const key = options?.keys?.[0]
    const token = options?.arguments?.[0]
    if (key == null) return 0
    const current = await this.get(key)
    if (current != null && current === token) {
      await this.del(key)
      return 1
    }
    return 0
  }
}
