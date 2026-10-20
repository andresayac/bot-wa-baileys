/**
 * In-memory fake of the node-redis v4 client surface used by RedisStore.
 *
 * Hermetic: no network, no real Redis. It models the server semantics the
 * store relies on — checked against a live server by the shared probes in
 * redis-probes.ts — including:
 *  - KEYS glob matching byte for byte like Redis' `stringmatchlen` (`*`, `?`,
 *    `[...]` classes with ranges/negation, backslash escapes);
 *  - ZRANGE by rank (no BY) vs BYSCORE (`(` exclusive bounds, REV swapping the
 *    bound order), LIMIT only with BYSCORE, a negative count meaning "all";
 *  - argument validation (integer ranks/LIMIT, positive integer EX/PX);
 *  - WRONGTYPE when a string key is used as a sorted set or vice versa;
 *  - MULTI without rollback (exec rejects after running every command);
 *  - EVAL of exactly the scripts the store sends, atomically.
 *
 * Expiry is lazy (checked on access) and deterministic — tests can force a key
 * to expire by rewriting its entry in {@link FakeRedisClient.expires}.
 * Commands run synchronously inside their async wrappers, so a command (and a
 * whole EVAL) is atomic while separate commands from concurrent callers still
 * interleave, like requests from several connections.
 */
import type { RedisLikeClient, RedisMulti, RedisZRangeOptions } from '../src/RedisStore.js'
import {
  ACQUIRE_FENCED_LOCK_SCRIPT, CAS_CHECKPOINT_SCRIPT, CLEAR_CHECKPOINT_IF_SCRIPT, DELETE_CHAT_SCRIPT, DROP_MESSAGE_SCRIPT, MERGE_CAS_SCRIPT,
  RELEASE_LOCK_SCRIPT, RENEW_LOCK_SCRIPT,
} from '../src/scripts.js'
import { FakeCoordState, evalCoordScript } from './fakeCoordScripts.js'
import { DURABLE_WRITE_SCRIPT } from '../src/durabilityScripts.js'

interface ZEntry {
  score: number
  value: string
}

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value'
const NOT_INTEGER = 'ERR value is not an integer or out of range'

/** The `revision` of a stored checkpoint JSON, as the Lua scripts read it (0 when absent/invalid). */
export function jsonRevision(raw: string | null): number {
  if (raw === null) return 0
  try {
    const doc = JSON.parse(raw) as { revision?: unknown } | null
    return typeof doc?.revision === 'number' ? doc.revision : 0
  } catch {
    return 0
  }
}

/** How node-redis serializes a numeric argument (Infinity becomes `+inf`/`-inf`, the rest `toString()`). */
function wireNumber(v: number | string): string {
  if (typeof v === 'string') return v
  if (v === Number.POSITIVE_INFINITY) return '+inf'
  if (v === Number.NEGATIVE_INFINITY) return '-inf'
  return v.toString()
}

/** Parse an argument Redis reads as a 64-bit integer (strict, like `string2ll`). */
function parseInteger(v: number | string): number {
  const s = typeof v === 'number' ? v.toString() : v
  if (!/^-?\d+$/.test(s)) throw new Error(NOT_INTEGER)
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new Error(NOT_INTEGER)
  return n
}

/** Parse a ZRANGE BYSCORE bound: a float, `±inf`, optionally prefixed with `(` (exclusive). */
function parseScoreBound(v: number | string): { value: number; exclusive: boolean } {
  let s = wireNumber(v)
  const exclusive = s.startsWith('(')
  if (exclusive) s = s.slice(1)
  const lower = s.toLowerCase()
  let value: number
  if (lower === '+inf' || lower === 'inf' || lower === '+infinity' || lower === 'infinity') value = Number.POSITIVE_INFINITY
  else if (lower === '-inf' || lower === '-infinity') value = Number.NEGATIVE_INFINITY
  else {
    value = s.trim() === s && s !== '' ? Number(s) : Number.NaN
    if (Number.isNaN(value)) throw new Error('ERR min or max is not a float')
  }
  return { value, exclusive }
}

/** Positive integer expiry, as SET … EX/PX requires. */
function parseExpire(v: number): number {
  const n = parseInteger(v)
  if (n <= 0) throw new Error("ERR invalid expire time in 'set' command")
  return n
}

/**
 * Redis' `stringmatchlen` (util.c), byte for byte: `pattern` and `str` are
 * UTF-8 bytes, so `?` matches one byte and classes compare bytes.
 */
export function stringMatch(pattern: string, str: string): boolean {
  const p = Buffer.from(pattern, 'utf8')
  const s = Buffer.from(str, 'utf8')
  const skipLonger = { value: false }
  return matchFrom(p, 0, s, 0, skipLonger)
}

function matchFrom(p: Buffer, pi: number, s: Buffer, si: number, skipLonger: { value: boolean }): boolean {
  let pLen = p.length - pi
  let sLen = s.length - si
  while (pLen > 0 && sLen > 0) {
    switch (p[pi]) {
      case 0x2a: { // '*'
        while (pLen > 1 && p[pi + 1] === 0x2a) {
          pi++
          pLen--
        }
        if (pLen === 1) return true
        while (sLen > 0) {
          if (matchFrom(p, pi + 1, s, si, skipLonger)) return true
          if (skipLonger.value) return false
          si++
          sLen--
        }
        skipLonger.value = true
        return false
      }
      case 0x3f: // '?'
        si++
        sLen--
        break
      case 0x5b: { // '['
        pi++
        pLen--
        const not = p[pi] === 0x5e // '^'
        if (not) {
          pi++
          pLen--
        }
        let match = false
        for (;;) {
          if (p[pi] === 0x5c && pLen >= 2) { // '\' escapes the next class char
            pi++
            pLen--
            if (p[pi] === s[si]) match = true
          } else if (p[pi] === 0x5d) { // ']'
            break
          } else if (pLen === 0) { // unterminated class
            pi--
            pLen++
            break
          } else if (pLen >= 3 && p[pi + 1] === 0x2d) { // range 'a-z'
            let start = p[pi]!
            let end = p[pi + 2]!
            const c = s[si]!
            if (start > end) [start, end] = [end, start]
            pi += 2
            pLen -= 2
            if (c >= start && c <= end) match = true
          } else if (p[pi] === s[si]) {
            match = true
          }
          pi++
          pLen--
        }
        if (not) match = !match
        if (!match) return false
        si++
        sLen--
        break
      }
      case 0x5c: // '\'
        if (pLen >= 2) {
          pi++
          pLen--
        }
      // falls through
      default:
        if (p[pi] !== s[si]) return false
        si++
        sLen--
        break
    }
    pi++
    pLen--
    if (sLen === 0) {
      while (pLen > 0 && p[pi] === 0x2a) {
        pi++
        pLen--
      }
      break
    }
  }
  return pLen === 0 && sLen === 0
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

  /** The live string at `key` (null when absent); WRONGTYPE when it holds a sorted set. */
  private readString(key: string): string | null {
    this.live(key)
    if (this.zsets.has(key)) throw new Error(WRONGTYPE)
    return this.strings.get(key) ?? null
  }

  /** The live sorted set at `key` (undefined when absent); WRONGTYPE when it holds a string. */
  private readZset(key: string): Map<string, number> | undefined {
    this.live(key)
    if (this.strings.has(key)) throw new Error(WRONGTYPE)
    return this.zsets.get(key)
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
    return this.readString(key)
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: true; XX?: true; EX?: number; PX?: number },
  ): Promise<string | null> {
    return this.setSync(key, value, options)
  }

  private setSync(key: string, value: string, options?: { NX?: true; XX?: true; EX?: number; PX?: number }): string | null {
    if (options?.NX && options.XX) throw new Error('ERR syntax error')
    // node-redis sends EX when given, PX only otherwise; validated before anything is written.
    const ttlMs = options?.EX !== undefined ? parseExpire(options.EX) * 1000 : options?.PX !== undefined ? parseExpire(options.PX) : undefined
    this.live(key)
    const exists = this.strings.has(key) || this.zsets.has(key)
    if (options?.NX && exists) return null
    if (options?.XX && !exists) return null
    this.zsets.delete(key) // SET replaces a key of any type
    this.strings.set(key, value)
    if (ttlMs !== undefined) this.expires.set(key, Date.now() + ttlMs)
    else this.expires.delete(key)
    return 'OK'
  }

  async del(key: string | string[]): Promise<number> {
    return this.delSync(key)
  }

  private delSync(key: string | string[]): number {
    const keys = Array.isArray(key) ? key : [key]
    let removed = 0
    for (const k of keys) {
      if (!this.live(k)) continue
      if (this.strings.delete(k) || this.zsets.delete(k)) removed++
      this.expires.delete(k)
    }
    return removed
  }

  /** Number of KEYS commands received (lets tests assert the store scanned instead). */
  keysCalls = 0

  async keys(pattern: string): Promise<string[]> {
    this.keysCalls++
    return this.matching(pattern)
  }

  /** Live keys matching a glob, in insertion order (the KEYS reply). */
  protected matching(pattern: string): string[] {
    const out: string[] = []
    for (const k of new Set([...this.strings.keys(), ...this.zsets.keys()])) {
      if (this.live(k) && stringMatch(pattern, k)) out.push(k)
    }
    return out
  }

  async zAdd(
    key: string,
    members: ZEntry | ZEntry[],
    options?: { NX?: true; XX?: true },
  ): Promise<number> {
    return this.zAddSync(key, members, options)
  }

  private zAddSync(key: string, members: ZEntry | ZEntry[], options?: { NX?: true; XX?: true }): number {
    if (options?.NX && options.XX) throw new Error('ERR XX and NX options at the same time are not compatible')
    const list = Array.isArray(members) ? members : [members]
    for (const m of list) {
      if (Number.isNaN(m.score)) throw new Error('ERR value is not a valid float')
    }
    let set = this.readZset(key)
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
    if (set.size === 0) this.zsets.delete(key)
    return added
  }

  /** Members ordered by (score, member bytes), ascending; reversed with `rev`. */
  private sorted(set: Map<string, number> | undefined, rev: boolean): ZEntry[] {
    if (!set) return []
    const entries = [...set.entries()].map(([value, score]) => ({ score, value }))
    entries.sort((a, b) => a.score - b.score || Buffer.compare(Buffer.from(a.value), Buffer.from(b.value)))
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
    if (options?.BY === 'LEX') throw new Error('FakeRedisClient does not model ZRANGE BYLEX')
    const rev = options?.REV === true
    const limit = options?.LIMIT
    if (limit && !options?.BY) {
      throw new Error('ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX')
    }

    if (!options?.BY) {
      // By rank: inclusive 0-based indices over the (possibly reversed) order; negatives count from the end.
      let start = parseInteger(wireNumber(min))
      let stop = parseInteger(wireNumber(max))
      const entries = this.sorted(this.readZset(key), rev)
      const n = entries.length
      if (start < 0) start = n + start
      if (stop < 0) stop = n + stop
      if (start < 0) start = 0
      if (start > stop || start >= n) return []
      if (stop >= n) stop = n - 1
      return entries.slice(start, stop + 1)
    }

    // BYSCORE: REV swaps the bound order, so the first argument is then the MAX bound.
    const lo = parseScoreBound(rev ? max : min)
    const hi = parseScoreBound(rev ? min : max)
    const offset = limit ? parseInteger(wireNumber(limit.offset)) : 0
    const count = limit ? parseInteger(wireNumber(limit.count)) : -1
    const entries = this.sorted(this.readZset(key), rev).filter(
      (e) =>
        (lo.exclusive ? e.score > lo.value : e.score >= lo.value) &&
        (hi.exclusive ? e.score < hi.value : e.score <= hi.value),
    )
    if (offset < 0) return []
    return count < 0 ? entries.slice(offset) : entries.slice(offset, offset + count)
  }

  async zRem(key: string, member: string | string[]): Promise<number> {
    return this.zRemSync(key, member)
  }

  private zRemSync(key: string, member: string | string[]): number {
    const set = this.readZset(key)
    if (!set) return 0
    const members = Array.isArray(member) ? member : [member]
    let removed = 0
    for (const m of members) if (set.delete(m)) removed++
    if (set.size === 0) {
      this.zsets.delete(key)
      this.expires.delete(key)
    }
    return removed
  }

  async zCard(key: string): Promise<number> {
    return this.readZset(key)?.size ?? 0
  }

  /**
   * MULTI — queue commands and run them back to back on exec() (nothing
   * interleaves). Like Redis there is no rollback: a failing command does not
   * undo the others, and exec() then rejects (node-redis' MultiErrorReply).
   */
  multi(): RedisMulti {
    const ops: Array<() => unknown> = []
    const tx: RedisMulti = {
      set: (key, value, options) => { ops.push(() => this.setSync(key, value, options)); return tx },
      del: (key) => { ops.push(() => this.delSync(key)); return tx },
      zAdd: (key, members, options) => { ops.push(() => this.zAddSync(key, members, options)); return tx },
      zRem: (key, member) => { ops.push(() => this.zRemSync(key, member)); return tx },
      exec: async () => {
        const results: unknown[] = []
        const errors: Error[] = []
        for (const op of ops) {
          try {
            results.push(op())
          } catch (e) {
            errors.push(e as Error)
            results.push(e)
          }
        }
        if (errors.length) throw new Error(`MultiErrorReply: ${errors.map((e) => e.message).join('; ')}`)
        return results
      },
    }
    return tx
  }

  /** Runs exactly the scripts RedisStore sends (atomically); any other script is rejected. */
  /** State of the RedisCoordinator scripts (modelled separately, see fakeCoordScripts.ts). */
  readonly coord = new FakeCoordState()

  async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    const keys = options?.keys ?? []
    const args = options?.arguments ?? []
    const coord = evalCoordScript(this.coord, script, keys, args)
    if (coord !== undefined) return coord
    if (script === ACQUIRE_FENCED_LOCK_SCRIPT) {
      const [lockKey, fenceKey] = keys
      const [token, ttl] = args
      if (lockKey == null || fenceKey == null || token == null || ttl == null) throw new Error('ERR fenced-lock script needs two keys and two arguments')
      if (this.setSync(lockKey, token, { NX: true, PX: Number(ttl) }) !== 'OK') return 0
      const next = Number(this.readString(fenceKey) ?? '0') + 1
      this.setSync(fenceKey, String(next))
      return next
    }
    if (script === RENEW_LOCK_SCRIPT) {
      const [lockKey] = keys
      const [token, ttl] = args
      if (lockKey == null || token == null || ttl == null) throw new Error('ERR renew-lock script needs one key and two arguments')
      if (this.readString(lockKey) !== token) return 0
      this.expires.set(lockKey, Date.now() + Number(ttl))
      return 1
    }
    if (script === RELEASE_LOCK_SCRIPT) {
      const [key] = keys
      if (key == null) throw new Error('ERR release-lock script needs one key')
      if (this.readString(key) === args[0]) return this.delSync(key)
      return 0
    }
    if (script === MERGE_CAS_SCRIPT) {
      const [key] = keys
      const [hasExpected, expected, next] = args
      if (key == null || hasExpected == null || next == null) throw new Error('ERR merge-cas script needs one key and three arguments')
      const current = this.readString(key)
      if (hasExpected === '0' ? current !== null : current !== expected) return 0
      this.setSync(key, next)
      return 1
    }
    if (script === CAS_CHECKPOINT_SCRIPT) {
      const [key] = keys
      const [expected, next, px] = args
      if (key == null || expected == null || next == null || px == null) throw new Error('ERR cas-checkpoint script needs one key and three arguments')
      if (jsonRevision(this.readString(key)) !== Number(expected)) return 0
      if (px !== '') this.setSync(key, next, { PX: Number(px) })
      else this.setSync(key, next)
      return 1
    }
    if (script === CLEAR_CHECKPOINT_IF_SCRIPT) {
      const [key] = keys
      const [expected] = args
      if (key == null || expected == null) throw new Error('ERR clear-checkpoint-if script needs one key and one argument')
      const current = this.readString(key)
      if (current === null) return 1
      if (jsonRevision(current) !== Number(expected)) return 0
      this.delSync(key)
      return 1
    }
    if (script === DROP_MESSAGE_SCRIPT) {
      const [setKey, itemKey] = keys
      const [member] = args
      if (setKey == null || itemKey == null || member == null) throw new Error('ERR drop-message script needs two keys and one argument')
      if (this.zRemSync(setKey, member) !== 1) return 0
      this.delSync(itemKey)
      return 1
    }
    if (script === DELETE_CHAT_SCRIPT) {
      const [setKey, chatKey] = keys
      const [itemPrefix] = args
      if (setKey == null || chatKey == null || itemPrefix == null) throw new Error('ERR delete-chat script needs two keys and one argument')
      const members = this.sorted(this.readZset(setKey), false).map((e) => e.value)
      if (members.length) this.delSync(members.map((m) => itemPrefix + m))
      this.delSync([setKey, chatKey])
      return members.length
    }
    if (script === DURABLE_WRITE_SCRIPT) {
      const [docKey, dueKey, doneKey] = keys
      const [mode, expected, next, member, due, done] = args
      if (docKey == null || dueKey == null || doneKey == null || member == null) throw new Error('ERR durable-write script needs three keys and six arguments')
      const current = this.readString(docKey)
      if (mode === 'insert' ? current !== null : current !== expected) return 0
      if (mode === 'remove') {
        this.delSync(docKey)
        this.zRemSync(dueKey, member)
        this.zRemSync(doneKey, member)
        return 1
      }
      this.setSync(docKey, next ?? '')
      for (const [key, value] of [[dueKey, due], [doneKey, done]] as const) {
        if (!value) this.zRemSync(key, member)
        else this.zAddSync(key, { score: Number(value), value: member })
      }
      return 1
    }
    throw new Error('NOSCRIPT FakeRedisClient: unknown script (only the scripts RedisStore sends are modelled)')
  }
}

/**
 * The fake plus node-redis' `scanIterator`: yields the matching keys in small
 * batches (v5 shape, `string[]`), repeating one key, since SCAN may legitimately
 * report a key more than once.
 */
export class ScanningFakeRedisClient extends FakeRedisClient {
  scanCalls = 0

  async *scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string | string[]> {
    this.scanCalls++
    const keys = this.matching(options?.MATCH ?? '*')
    for (let i = 0; i < keys.length; i += 2) {
      const batch = keys.slice(i, i + 2)
      yield i === 0 ? batch : [keys[0]!, ...batch] // a duplicate on every later step
    }
  }
}
