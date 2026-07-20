import { describe, it, expect } from 'vitest'
import { parseDuration } from '../src/utils/duration.js'

describe('parseDuration', () => {
  it('parses ms', () => {
    expect(parseDuration('500ms')).toBe(500)
  })
  it('parses seconds', () => {
    expect(parseDuration('90s')).toBe(90_000)
  })
  it('parses minutes', () => {
    expect(parseDuration('2m')).toBe(120_000)
  })
  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
  })
  it('passes plain numbers through as milliseconds', () => {
    expect(parseDuration(250)).toBe(250)
  })
  it('parses decimal values', () => {
    expect(parseDuration('1.5m')).toBe(90_000)
  })
  it('throws on invalid formats', () => {
    expect(() => parseDuration('5 days')).toThrow(/Invalid duration/)
    expect(() => parseDuration('abc')).toThrow(/Invalid duration/)
    expect(() => parseDuration('')).toThrow(/Invalid duration/)
  })
})
