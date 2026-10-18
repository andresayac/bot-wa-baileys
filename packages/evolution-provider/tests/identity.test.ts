import { describe, it, expect } from 'vitest'
import { WaIdentityStore, normalizeJid } from '../src/identity.js'

describe('WaIdentityStore', () => {
  it('strips device suffixes and rejects empty ids', () => {
    expect(normalizeJid('573001112233:12@s.whatsapp.net')).toBe('573001112233@s.whatsapp.net')
    expect(normalizeJid('  ')).toBeUndefined()
    expect(normalizeJid(undefined)).toBeUndefined()
  })

  it('prefers the PN, keeps the first-seen id when the PN arrives later', () => {
    const ids = new WaIdentityStore()
    expect(ids.resolve('1@lid', '57@s.whatsapp.net')).toBe('57@s.whatsapp.net')
    expect(ids.resolve('1@lid')).toBe('57@s.whatsapp.net')
    expect(ids.resolve('2@lid')).toBe('2@lid')
    expect(ids.resolve('2@lid', '58@s.whatsapp.net')).toBe('2@lid')
    expect(ids.lookup('58@s.whatsapp.net')).toBe('2@lid')
    expect(ids.resolve(undefined)).toBeUndefined()
  })

  it('is bounded', () => {
    const ids = new WaIdentityStore(3)
    for (let i = 0; i < 10; i++) ids.resolve(`${i}@lid`)
    expect(ids.size).toBe(3)
    expect(ids.has('9@lid')).toBe(true)
    expect(ids.has('0@lid')).toBe(false)
  })
  it('keeps the PN/LID link of an active contact (recency, not insertion order)', () => {
    const ids = new WaIdentityStore(4)
    ids.resolve('111@s.whatsapp.net', '999@lid')
    for (let i = 0; i < 4; i++) {
      expect(ids.resolve('999@lid')).toBe('111@s.whatsapp.net')
      ids.resolve(`2${i}@s.whatsapp.net`)
    }
    expect(ids.resolve('999@lid')).toBe('111@s.whatsapp.net')
  })
})

describe('WaIdentityStore persistence', () => {
  it('reuses the canonical id stored by a previous process', () => {
    const db = new Map<string, string>()
    const persistence = { get: (a: string) => db.get(a), set: (a: string, c: string) => { db.set(a, c) } }
    const before = new WaIdentityStore(100, persistence)
    expect(before.resolve('999@lid')).toBe('999@lid')
    // restart: the first message now carries the PN twin
    const after = new WaIdentityStore(100, persistence)
    expect(after.resolve('111@s.whatsapp.net', '999@lid')).toBe('999@lid')
    expect(after.lookup('111@s.whatsapp.net')).toBe('999@lid')
  })

  it('recovers evicted links from the persistence and only writes on change', () => {
    const db = new Map<string, string>()
    let writes = 0
    const ids = new WaIdentityStore(2, { get: (a) => db.get(a), set: (a, c) => { writes++; db.set(a, c) } })
    ids.resolve('111@s.whatsapp.net', '999@lid')
    ids.resolve('2@s.whatsapp.net')
    ids.resolve('3@s.whatsapp.net')
    expect(ids.resolve('999@lid')).toBe('111@s.whatsapp.net')
    expect(writes).toBe(4)
  })
})
