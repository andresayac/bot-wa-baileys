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
})
