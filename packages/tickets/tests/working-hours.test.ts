import { describe, expect, it } from 'vitest'
import { isWithinWorkingHours, parseWorkingHours } from '../src/index.js'

const utc = (y: number, m: number, d: number, h: number, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min))

describe('parseWorkingHours', () => {
  it('parses "9-18" and "09:30-18:15" as every-day windows', () => {
    expect(parseWorkingHours('9-18')).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], start: 540, end: 1080 }])
    expect(parseWorkingHours('09:30-18:15')).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], start: 570, end: 1095 }])
  })

  it('parses objects and arrays of windows', () => {
    expect(parseWorkingHours({ days: [1, 2, 3, 4, 5], start: '08:00', end: 17 })).toEqual([
      { days: [1, 2, 3, 4, 5], start: 480, end: 1020 },
    ])
    expect(parseWorkingHours([{ start: 9, end: 13 }, { start: '15:00', end: '19:00', days: [6] }])).toHaveLength(2)
  })

  it('rejects malformed input', () => {
    expect(() => parseWorkingHours('9 to 18')).toThrow(/workingHours/)
    expect(() => parseWorkingHours('25-26')).toThrow(/workingHours/)
    expect(() => parseWorkingHours({ start: '9:00', end: '18:00', days: [7] })).toThrow(/days/)
  })
})

describe('isWithinWorkingHours', () => {
  it('checks day and time in the configured timezone', () => {
    const wh = parseWorkingHours({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' })
    expect(isWithinWorkingHours(wh, utc(2026, 1, 5, 9, 0), 'UTC')).toBe(true) // Monday 09:00
    expect(isWithinWorkingHours(wh, utc(2026, 1, 5, 18, 0), 'UTC')).toBe(false) // end is exclusive
    expect(isWithinWorkingHours(wh, utc(2026, 1, 4, 12, 0), 'UTC')).toBe(false) // Sunday
    // 14:00 UTC is 09:00 in Bogotá (UTC-5) → open; 13:00 UTC is 08:00 → closed
    expect(isWithinWorkingHours(wh, utc(2026, 1, 5, 14, 0), 'America/Bogota')).toBe(true)
    expect(isWithinWorkingHours(wh, utc(2026, 1, 5, 13, 0), 'America/Bogota')).toBe(false)
  })

  it('supports overnight windows (start > end)', () => {
    const wh = parseWorkingHours('22-6')
    expect(isWithinWorkingHours(wh, utc(2026, 1, 5, 23), 'UTC')).toBe(true)
    expect(isWithinWorkingHours(wh, utc(2026, 1, 6, 3), 'UTC')).toBe(true)
    expect(isWithinWorkingHours(wh, utc(2026, 1, 6, 12), 'UTC')).toBe(false)
  })

  it('a function predicate is used as-is', () => {
    const wh = parseWorkingHours(() => true)
    expect(isWithinWorkingHours(wh, new Date(), 'UTC')).toBe(true)
  })
})
