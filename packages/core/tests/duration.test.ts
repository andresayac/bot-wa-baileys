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
  it('accepts days, weeks and long unit names (one grammar for every option)', () => {
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('5 days')).toBe(5 * 86_400_000)
    expect(parseDuration('1w')).toBe(604_800_000)
    expect(parseDuration('2 minutes')).toBe(120_000)
    expect(parseDuration('250')).toBe(250)
  })
  it('is the same function the public entry exports', async () => {
    const pub = await import('../src/index.js')
    expect(pub.parseDuration('1d')).toBe(parseDuration('1d'))
    expect(() => pub.parseDuration('2 minutos')).toThrow(/Invalid duration/)
  })
  it('throws on invalid formats', () => {
    expect(() => parseDuration('5 parsecs')).toThrow(/Invalid duration/)
    expect(() => parseDuration('abc')).toThrow(/Invalid duration/)
    expect(() => parseDuration('')).toThrow(/Invalid duration/)
  })
})
