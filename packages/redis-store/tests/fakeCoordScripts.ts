/**
 * In-memory model of the RedisCoordinator Lua scripts (coordScripts.ts) for the
 * hermetic tests. Each handler mirrors its script line by line and runs synchronously
 * (atomically, like EVAL). The integration suite runs the real scripts against a real
 * server, so the two cannot drift silently.
 */
import {
  HEARTBEAT_SCRIPT,
  LEAD_RELEASE_SCRIPT,
  LEAD_SCRIPT,
  LEAVE_SCRIPT,
  RELEASE_TURN_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  TURN_SCRIPT,
} from '../src/coordScripts.js'

export class FakeCoordState {
  readonly strings = new Map<string, string>()
  readonly hashes = new Map<string, Map<string, string>>()
  readonly expires = new Map<string, number>()

  private live(key: string): boolean {
    const at = this.expires.get(key)
    if (at !== undefined && at <= Date.now()) {
      this.strings.delete(key)
      this.hashes.delete(key)
      this.expires.delete(key)
      return false
    }
    return this.strings.has(key) || this.hashes.has(key)
  }
  get(key: string): string | null { return this.live(key) ? (this.strings.get(key) ?? null) : null }
  set(key: string, value: string, px?: number): void {
    this.strings.set(key, value)
    if (px !== undefined) this.expires.set(key, Date.now() + px)
    else this.expires.delete(key)
  }
  del(key: string): number {
    const had = this.live(key)
    this.strings.delete(key); this.hashes.delete(key); this.expires.delete(key)
    return had ? 1 : 0
  }
  exists(key: string): boolean { return this.live(key) }
  incr(key: string): number {
    const n = Number(this.get(key) ?? '0') + 1
    const at = this.expires.get(key)
    this.strings.set(key, String(n))
    if (at === undefined) this.expires.delete(key)
    return n
  }
  pexpire(key: string, ms: number): number {
    if (!this.live(key)) return 0
    this.expires.set(key, Date.now() + ms)
    return 1
  }
  persist(key: string): void { this.expires.delete(key) }
  hget(key: string, field: string): string | null { return this.live(key) ? (this.hashes.get(key)?.get(field) ?? null) : null }
  hset(key: string, field: string, value: string): void {
    if (!this.live(key)) this.hashes.set(key, new Map())
    this.hashes.get(key)!.set(field, value)
  }
  hdel(key: string, field: string): void {
    const h = this.live(key) ? this.hashes.get(key) : undefined
    if (!h) return
    h.delete(field)
    if (h.size === 0) this.del(key)
  }
  hlen(key: string): number { return this.live(key) ? (this.hashes.get(key)?.size ?? 0) : 0 }

  /** Force a key to expire now (simulates the PX deadline passing). */
  expireNow(key: string): void { this.expires.set(key, Date.now() - 1) }
}

/** Run a coordinator script, or return `undefined` when `script` is not one of them. */
export function evalCoordScript(state: FakeCoordState, script: string, keys: string[], args: string[]): unknown {
  const s = state
  switch (script) {
    case HEARTBEAT_SCRIPT:
      s.set(keys[0]!, '1', Number(args[0]))
      return 1
    case LEAVE_SCRIPT:
      return s.del(keys[0]!)
    case RESERVE_SCRIPT: {
      const [seqK, tixK, servingK, lastK] = keys as [string, string, string, string]
      const n = s.incr(seqK)
      s.hset(tixK, String(n), args[0]!)
      if (!s.exists(servingK)) s.set(servingK, String(n))
      s.persist(seqK); s.persist(servingK); s.persist(lastK)
      return n
    }
    case TURN_SCRIPT: {
      const [servingK, ownerK, tixK, lastK] = keys as [string, string, string, string]
      const [seqArg, rid, leaseMs, repPrefix] = args as [string, string, string, string]
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
          if (s.exists(repPrefix + h)) return [0, '']
          if (s.get(ownerK) === `${cur}|${h}`) return [0, '']
          s.hdel(tixK, String(cur))
        }
        s.incr(servingK)
      }
      return [0, '']
    }
    case RENEW_SCRIPT:
      return s.get(keys[0]!) === args[0] ? s.pexpire(keys[0]!, Number(args[1])) : 0
    case RELEASE_TURN_SCRIPT: {
      const [servingK, ownerK, tixK, lastK, seqK] = keys as [string, string, string, string, string]
      const [seqArg, rid, idleMs] = args as [string, string, string]
      const mine = `${seqArg}|${rid}`
      const curRaw = s.get(servingK)
      const ours = s.hget(tixK, seqArg) === rid
      if (curRaw !== null && Number(curRaw) === Number(seqArg) && ours) {
        const o = s.get(ownerK)
        if (o !== null && o !== mine) return 0
        s.del(ownerK)
        s.hdel(tixK, seqArg)
        s.set(lastK, rid)
        s.incr(servingK)
        if (s.hlen(tixK) === 0) {
          s.pexpire(servingK, Number(idleMs)); s.pexpire(lastK, Number(idleMs)); s.pexpire(seqK, Number(idleMs))
        }
        return 1
      }
      if (ours) { s.hdel(tixK, seqArg); return 2 }
      return 0
    }
    case LEAD_SCRIPT: {
      const [leadK, termK] = keys as [string, string]
      const [rid, leaseMs] = args as [string, string]
      const cur = s.get(leadK)
      if (cur === null) {
        const t = s.incr(termK)
        s.set(leadK, `${t}|${rid}`, Number(leaseMs))
        return t
      }
      const sep = cur.indexOf('|')
      if (sep >= 0 && cur.slice(sep + 1) === rid) {
        s.pexpire(leadK, Number(leaseMs))
        return Number(cur.slice(0, sep))
      }
      return 0
    }
    case LEAD_RELEASE_SCRIPT:
      return s.get(keys[0]!) === args[0] ? s.del(keys[0]!) : 0
    default:
      return undefined
  }
}
