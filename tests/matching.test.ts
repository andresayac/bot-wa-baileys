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
  it('startsWith strategy', () => {
    expect(matchTrigger({ pattern: 'hola', match: 'startsWith' }, dm('Hóla amigo'))).toBe(true)
    expect(matchTrigger({ pattern: 'hola', match: 'startsWith' }, dm('digo hola'))).toBe(false)
  })
  it('endsWith strategy', () => {
    expect(matchTrigger({ pattern: 'amigo', match: 'endsWith' }, dm('hola AMIGO '))).toBe(true)
    expect(matchTrigger({ pattern: 'amigo', match: 'endsWith' }, dm('amigo hola'))).toBe(false)
  })
  it('TriggerObject with a RegExp pattern', () => {
    expect(matchTrigger({ pattern: /\d{4,}/ }, dm('code 12345'))).toBe(true)
    expect(matchTrigger({ pattern: /\d{4,}/ }, dm('code 123'))).toBe(false)
  })
  it('mixed array in TriggerObject with equals', () => {
    const trigger = { pattern: ['hola', /chao/], match: 'equals' as const }
    expect(matchTrigger(trigger, dm('Hola'))).toBe(true)
    expect(triggerSpecificity(trigger)).toBe(40)
  })
  it('scope dm rejects groups', () => {
    expect(matchTrigger({ pattern: 'x', scope: 'dm' }, { body: 'x', isGroup: true })).toBe(false)
  })
  it('scope group accepts groups', () => {
    expect(matchTrigger({ pattern: 'x', scope: 'group' }, { body: 'x', isGroup: true })).toBe(true)
  })
  it('default scope all accepts both dm and group', () => {
    expect(matchTrigger({ pattern: 'x' }, { body: 'x', isGroup: true })).toBe(true)
    expect(matchTrigger({ pattern: 'x' }, { body: 'x', isGroup: false })).toBe(true)
  })
  it('empty array never matches and has specificity 0', () => {
    expect(matchTrigger([], dm('anything'))).toBe(false)
    expect(triggerSpecificity([])).toBe(0)
    expect(matchTrigger({ pattern: [] }, dm('anything'))).toBe(false)
    expect(triggerSpecificity({ pattern: [] })).toBe(0)
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
