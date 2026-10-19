/**
 * Key layouts (legacy vs cluster) and hash-slot helpers — pure, no client.
 */
import { describe, expect, it } from 'vitest'
import {
  INDEX_BUCKETS, assertLayoutPrefix, bucketOf, coordKeys, encodeSegment, scheduleKeys, storeKeys, userDataKeys,
} from '../src/layout.js'
import { assertOneSlot, hashSlot, hashTagOf } from '../src/slot.js'

const ADVERSARIAL = ['', '{', '}', '{}', 'a}b{', ':', '%', '*', '?', '[x]', 'ñandú 🦜', 'x'.repeat(1024), '{m:a}', 'a:b:c', 'item:x']

describe('hashSlot', () => {
  it('matches the CRC16 test vectors of the Redis Cluster spec', () => {
    expect(hashSlot('123456789')).toBe(12739)
    expect(hashSlot('foo')).toBe(12182)
    expect(hashSlot('')).toBe(0)
  })

  it('applies the hash-tag rule', () => {
    expect(hashSlot('{user1000}.following')).toBe(hashSlot('user1000'))
    expect(hashSlot('foo{}{bar}')).toBe(hashSlot('foo{}{bar}'))
    expect(hashSlot('foo{}{bar}')).not.toBe(hashSlot('bar'))
    expect(hashSlot('foo{{bar}}zap')).toBe(hashSlot('{bar'))
    expect(hashSlot('foo{bar}{zap}')).toBe(hashSlot('bar'))
    expect(hashTagOf('a{b}c')).toBe('b')
    expect(hashTagOf('a{}c')).toBeUndefined()
    expect(hashTagOf('abc')).toBeUndefined()
  })

  it('hashes UTF-8 bytes', () => {
    // 'ñ' is the two bytes C3 B1; its latin1 spelling is two characters, but different code units.
    expect(hashSlot('ñ')).not.toBe(hashSlot('Ã±'))
    expect(hashSlot('ñ')).toBeGreaterThanOrEqual(0)
    expect(hashSlot('ñ')).toBeLessThan(16384)
  })

  it('assertOneSlot accepts one slot and rejects several', () => {
    expect(() => assertOneSlot(['{a}x', '{a}y'])).not.toThrow()
    expect(() => assertOneSlot([])).not.toThrow()
    expect(() => assertOneSlot(['a', 'b'])).toThrow(/hash slot/)
  })
})

describe('bucketOf', () => {
  it('is FNV-1a 32 over UTF-8 modulo INDEX_BUCKETS (fixed vectors: a layout contract)', () => {
    expect(INDEX_BUCKETS).toBe(32)
    // FNV-1a("") = 0x811c9dc5, FNV-1a("a") = 0xe40c292c, FNV-1a("foobar") = 0xbf9cf968
    expect(bucketOf('')).toBe(0x811c9dc5 % 32)
    expect(bucketOf('a')).toBe(0xe40c292c % 32)
    expect(bucketOf('foobar')).toBe(0xbf9cf968 % 32)
    for (const id of ADVERSARIAL) {
      const b = bucketOf(id)
      expect(Number.isInteger(b) && b >= 0 && b < 32).toBe(true)
    }
  })
})

describe('encodeSegment', () => {
  it('leaves no separator, brace or glob character', () => {
    for (const id of ADVERSARIAL) expect(encodeSegment(id)).not.toMatch(/[:{}*?[\]!'()~]/)
    expect(decodeURIComponent(encodeSegment("a:b{c}*!'()~"))).toBe("a:b{c}*!'()~")
  })
})

describe('legacy layout (golden: exactly the historical key names)', () => {
  const k = storeKeys('botwa', 'legacy')
  it('store keys', () => {
    expect(k.layout).toBe('legacy')
    expect(k.msgSet('c1')).toBe('botwa:msg:c1')
    expect(k.msgItem('c1', 'c1:m1')).toBe('botwa:msg:item:c1:m1')
    expect(k.chat('c1')).toBe('botwa:chat:c1')
    expect(k.chatIndex('c1')).toBeUndefined()
    expect(k.contact('u1')).toBe('botwa:contact:u1')
    expect(k.contactIndex('u1')).toBeUndefined()
    expect(k.checkpoint('k')).toBe('botwa:cp:k')
    expect(k.checkpointIndex('k')).toBeUndefined()
    expect(k.conversation('k')).toBe('botwa:conv:k')
    expect(k.cursor('k')).toBe('botwa:cursor:k')
    expect(k.lock('k')).toBe('botwa:lock:k')
    expect(k.lockFence('k')).toBe('botwa:lockfence:k')
    expect(k.indexes('chat')).toEqual([])
  })
  it('coordinator, schedule and user-data keys', () => {
    const c = coordKeys('botwa', 'legacy')
    expect(c.rep('r#1')).toBe('botwa:co:rep:r#1')
    expect(c.repPrefix).toBe('botwa:co:rep:')
    expect(c.turn('chat')).toEqual({
      seq: 'botwa:co:t:chat:seq', tix: 'botwa:co:t:chat:tix', serving: 'botwa:co:t:chat:serving',
      owner: 'botwa:co:t:chat:owner', last: 'botwa:co:t:chat:last',
    })
    expect(c.lead('session')).toEqual({ lease: 'botwa:co:lead:session', term: 'botwa:co:lead:session:term' })
    const s = scheduleKeys('botwa', 'legacy')
    expect(s.record('daily')).toBe('botwa:sched:daily')
    expect(s.index('daily')).toBeUndefined()
    expect(s.all()).toEqual([])
    const u = userDataKeys('botwa', 'legacy')
    expect(u.entry('u:1', 'n*s', 'k')).toBe('botwa:ud:u%3A1:n%2As:k')
    expect(u.index('u:1')).toBeUndefined()
  })
})

describe('cluster layout', () => {
  const k = storeKeys('botwa', 'cluster')
  const c = coordKeys('botwa', 'cluster')
  const s = scheduleKeys('botwa', 'cluster')
  const u = userDataKeys('botwa', 'cluster')

  it('keeps every multi-key group in one slot, behind a complete non-empty hash tag', () => {
    for (const id of ADVERSARIAL) {
      const groups = [
        [k.msgSet(id), k.msgItem(id, 'm1'), k.msgItem(id, `${id}:legacy`)],
        [k.chat(id), k.chatIndex(id)!],
        [k.contact(id), k.contactIndex(id)!],
        [k.checkpoint(id), k.checkpointIndex(id)!],
        [k.lock(id), k.lockFence(id)],
        Object.values(c.turn(id)),
        [c.lead(id).lease, c.lead(id).term],
        [s.record(id), s.index(id)!],
        [u.entry(id, 'ns', 'k'), u.entry(id, id, id), u.index(id)!],
      ]
      for (const g of groups) {
        expect(() => assertOneSlot(g)).not.toThrow()
        for (const key of g) expect(hashTagOf(key)).toBeTruthy()
      }
    }
  })

  it('indexes() lists every bucket of a kind, and records land in their bucket index', () => {
    expect(k.indexes('chat')).toHaveLength(INDEX_BUCKETS)
    expect(new Set(k.indexes('contact')).size).toBe(INDEX_BUCKETS)
    expect(k.indexes('chat')).toContain(k.chatIndex('x'))
    expect(k.indexes('cp')).toContain(k.checkpointIndex('x'))
    expect(s.all()).toContain(s.index('x'))
  })

  it('is injective: distinct (namespace, id) never share a key', () => {
    const seen = new Map<string, string>()
    const add = (label: string, key: string) => {
      const prev = seen.get(key)
      if (prev !== undefined && prev !== label) throw new Error(`${label} collides with ${prev}: ${key}`)
      seen.set(key, label)
    }
    for (const id of ADVERSARIAL) {
      add(`msgSet ${id}`, k.msgSet(id))
      add(`chat ${id}`, k.chat(id))
      add(`contact ${id}`, k.contact(id))
      add(`cp ${id}`, k.checkpoint(id))
      add(`conv ${id}`, k.conversation(id))
      add(`cursor ${id}`, k.cursor(id))
      add(`lock ${id}`, k.lock(id))
      add(`fence ${id}`, k.lockFence(id))
      add(`sched ${id}`, s.record(id))
      add(`ud ${id}`, u.entry(id, 'n', 'k'))
      add(`ud-ns ${id}`, u.entry('u', id, 'k'))
      add(`ud-k ${id}`, u.entry('u', 'n', id))
      for (const [n, key] of Object.entries(c.turn(id))) add(`turn.${n} ${id}`, key)
      add(`lead ${id}`, c.lead(id).lease)
      add(`term ${id}`, c.lead(id).term)
    }
    expect(seen.size).toBeGreaterThan(ADVERSARIAL.length * 10)
  })

  it('never collides with a legacy key name', () => {
    const legacy = storeKeys('botwa', 'legacy')
    for (const id of ADVERSARIAL) {
      expect([legacy.msgSet(id), legacy.chat(id), legacy.contact(id), legacy.checkpoint(id)]).not.toContain(k.chat(id))
      expect(k.msgSet(id).startsWith('botwa:{')).toBe(true)
    }
    expect(k.meta()).toBe('botwa:{meta}:layout')
  })

  it('rejects a prefix with braces in the cluster layout only', () => {
    expect(() => assertLayoutPrefix('a{b}', 'cluster', 'Test')).toThrow(RangeError)
    expect(() => storeKeys('a}b', 'cluster')).toThrow(RangeError)
    expect(() => storeKeys('a{b}', 'legacy')).not.toThrow()
    expect(() => assertLayoutPrefix('ok', 'cluster', 'Test')).not.toThrow()
    expect(() => assertLayoutPrefix('ok', 'weird' as never, 'Test')).toThrow(RangeError)
  })
})
