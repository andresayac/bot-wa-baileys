import { describe, it, expect } from 'vitest'
import { parseJsonLossless } from '../src/json.js'

describe('parseJsonLossless', () => {
  it('keeps 64-bit integer ids exact (as strings)', () => {
    const v = parseJsonLossless('{"comment_id":7247303576418566913,"n":5,"f":1.5,"neg":-7247303576418566913}') as Record<string, unknown>
    expect(v.comment_id).toBe('7247303576418566913')
    expect(v.neg).toBe('-7247303576418566913')
    expect(v.n).toBe(5)
    expect(v.f).toBe(1.5)
  })
  it('does not touch digits inside strings', () => {
    const v = parseJsonLossless('{"text":"a:7247303576418566913}"}') as Record<string, unknown>
    expect(v.text).toBe('a:7247303576418566913}')
  })
  it('works on nested arrays', () => {
    expect(parseJsonLossless('[9007199254740993]')).toEqual(['9007199254740993'])
  })
})
