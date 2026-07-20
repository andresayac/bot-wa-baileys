import { describe, it, expect } from 'vitest'
import { normalizeText, matchTrigger, triggerSpecificity } from '../src/core/matching.js'

const dm = (body: string) => ({ body, isGroup: false })

describe('normalizeText', () => {
  it('trims, lowercases, collapses spaces, strips diacritics', () => {
    expect(normalizeText('  Hóla   Món do ')).toBe('hola mon do')
  })
})

describe('matchTrigger', () => {
  it('string default is normalized equals', () => {
    expect(matchTrigger('hola', dm('Hóla '))).toBe(true)
    expect(matchTrigger('hola', dm('/hola'))).toBe(false)   // el bug del transcript
    expect(matchTrigger('hola', dm('hola amigo'))).toBe(false)
  })
  it('array matches any', () => {
    expect(matchTrigger(['adios', 'chao'], dm('CHAO'))).toBe(true)
  })
  it('contains only as opt-in', () => {
    expect(matchTrigger({ pattern: 'hola', match: 'contains' }, dm('digo hola amigo'))).toBe(true)
  })
  it('regex works and scope filters groups', () => {
    expect(matchTrigger(/\d{4,}/, dm('code 12345'))).toBe(true)
    expect(matchTrigger({ pattern: 'x', scope: 'group' }, dm('x'))).toBe(false)
  })
  it('function trigger', () => {
    expect(matchTrigger((c) => c.body.length > 3, dm('abcd'))).toBe(true)
  })
})

describe('triggerSpecificity', () => {
  it('orders equals > startsWith > regex > contains > fn', () => {
    expect(triggerSpecificity('hola')).toBeGreaterThan(triggerSpecificity({ pattern: 'h', match: 'startsWith' }))
    expect(triggerSpecificity({ pattern: 'h', match: 'startsWith' })).toBeGreaterThan(triggerSpecificity(/x/))
    expect(triggerSpecificity(/x/)).toBeGreaterThan(triggerSpecificity({ pattern: 'h', match: 'contains' }))
    expect(triggerSpecificity({ pattern: 'h', match: 'contains' })).toBeGreaterThan(triggerSpecificity(() => true))
  })
})
