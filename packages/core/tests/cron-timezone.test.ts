/**
 * Cron in an IANA time zone: fixed instants only, so nothing depends on the host zone.
 * The DST policy under test (scheduler guide): a fixed-hour slot in a skipped hour is
 * shifted forward by the gap; in a repeated hour it runs once (first occurrence);
 * wildcard-hour slots follow the real clock (dropped in a gap, both passes in an overlap).
 */
import { describe, expect, it } from 'vitest'
import { cronNextRun } from '../src/index.js'

const iso = (s: string) => new Date(s)
/** The next `n` run instants after `from`, as ISO strings. */
function runs(expr: string, from: string, tz: string, n: number): string[] {
  const out: string[] = []
  let at = iso(from)
  for (let i = 0; i < n; i++) {
    const next = cronNextRun(expr, at, tz)
    if (!next) break
    out.push(next.toISOString())
    at = next
  }
  return out
}

describe('cronNextRun with a time zone: fixed offsets', () => {
  it('reads the fields in UTC', () => {
    expect(cronNextRun('0 9 * * *', iso('2026-01-01T09:00:00Z'), 'UTC')?.toISOString()).toBe('2026-01-02T09:00:00.000Z')
  })

  it('handles a half-hour offset (Asia/Kolkata, +05:30)', () => {
    expect(cronNextRun('0 9 * * *', iso('2026-01-01T00:00:00Z'), 'Asia/Kolkata')?.toISOString()).toBe('2026-01-01T03:30:00.000Z')
    expect(cronNextRun('0 9 * * 1', iso('2026-01-01T00:00:00Z'), 'Asia/Kolkata')?.toISOString()).toBe('2026-01-05T03:30:00.000Z')
  })

  it('evaluates the calendar fields on the zone date, not the UTC date', () => {
    // 2026-01-01T02:00Z is still Dec 31 in Bogota (-05): "the 1st at 00:30" is 05:30Z that day.
    expect(cronNextRun('30 0 1 * *', iso('2026-01-01T02:00:00Z'), 'America/Bogota')?.toISOString()).toBe('2026-01-01T05:30:00.000Z')
  })

  it('reaches a leap day four years out (horizon)', () => {
    expect(cronNextRun('0 0 29 2 *', iso('2026-03-01T00:00:00Z'), 'UTC')?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
  })

  it("'local' and no zone keep the legacy host-local result", () => {
    const from = iso('2026-05-05T10:17:00Z')
    for (const expr of ['*/7 * * * *', '0 9 * * 1-5', '30 2 * * *']) {
      expect(cronNextRun(expr, from, 'local')?.getTime()).toBe(cronNextRun(expr, from)?.getTime())
    }
  })

  it('throws a RangeError for an unknown zone', () => {
    expect(() => cronNextRun('0 9 * * *', new Date(), 'Mars/Olympus')).toThrow(RangeError)
  })
})

describe('cronNextRun with a time zone: DST transitions', () => {
  const NY = 'America/New_York'

  it('NY spring forward (2026-03-08): fixed hours shift, wildcard hours skip the gap', () => {
    expect(cronNextRun('30 2 * * *', iso('2026-03-08T05:00:00Z'), NY)?.toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(cronNextRun('0 2 * * *', iso('2026-03-08T05:00:00Z'), NY)?.toISOString()).toBe('2026-03-08T07:00:00.000Z')
    expect(runs('*/30 * * * *', '2026-03-08T06:00:00Z', NY, 3)).toEqual([
      '2026-03-08T06:30:00.000Z', // 01:30 EST
      '2026-03-08T07:00:00.000Z', // 03:00 EDT: no 02:xx
      '2026-03-08T07:30:00.000Z',
    ])
    // 02:30 shifted onto 03:30: one run.
    expect(runs('30 2,3 * * *', '2026-03-08T05:00:00Z', NY, 2)).toEqual(['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z'])
  })

  it('NY fall back (2026-11-01): fixed hours run once, wildcard hours run both passes', () => {
    expect(runs('30 1 * * *', '2026-11-01T04:00:00Z', NY, 2)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
    expect(runs('*/30 * * * *', '2026-11-01T04:30:00Z', NY, 5)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ])
    expect(runs('0 * * * *', '2026-11-01T04:30:00Z', NY, 3)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ])
  })

  it('Europe/Madrid (2026-03-29 and 2026-10-25)', () => {
    expect(cronNextRun('30 2 * * *', iso('2026-03-28T23:00:00Z'), 'Europe/Madrid')?.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(runs('30 2 * * *', '2026-10-24T23:00:00Z', 'Europe/Madrid', 2)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z'])
  })

  it('America/Santiago: a transition at midnight still runs on the calendar day', () => {
    // 2026-09-06 00:00 (-04) does not exist: midnight becomes 01:00 (-03) = 04:00Z.
    expect(cronNextRun('0 0 * * *', iso('2026-09-05T12:00:00Z'), 'America/Santiago')?.toISOString()).toBe('2026-09-06T04:00:00.000Z')
    expect(cronNextRun('0 0 6 9 *', iso('2026-09-01T12:00:00Z'), 'America/Santiago')?.toISOString()).toBe('2026-09-06T04:00:00.000Z')
    // 2026-04-04 23:xx happens twice (24:00 -03 → 23:00 -04): a fixed hour runs at the first.
    expect(runs('30 23 * * *', '2026-04-04T12:00:00Z', 'America/Santiago', 2)).toEqual([
      '2026-04-05T02:30:00.000Z',
      '2026-04-06T03:30:00.000Z',
    ])
  })

  it('Australia/Lord_Howe: a 30-minute shift', () => {
    // 2026-10-04 02:00 (+10:30) → 02:30 (+11): 02:15 is shifted to 02:45 (+11).
    expect(cronNextRun('15 2 * * *', iso('2026-10-03T12:00:00Z'), 'Australia/Lord_Howe')?.toISOString()).toBe('2026-10-03T15:45:00.000Z')
  })

  it('Australia/Sydney (southern hemisphere)', () => {
    // 2026-10-04 02:00 AEST → 03:00 AEDT; 2026-04-05 03:00 AEDT → 02:00 AEST.
    expect(cronNextRun('30 2 * * *', iso('2026-10-03T12:00:00Z'), 'Australia/Sydney')?.toISOString()).toBe('2026-10-03T16:30:00.000Z')
    expect(cronNextRun('30 2 * * *', iso('2026-04-04T12:00:00Z'), 'Australia/Sydney')?.toISOString()).toBe('2026-04-04T15:30:00.000Z')
  })

  it('Pacific/Apia: the skipped day (2011-12-30) collides with the next day and runs once', () => {
    expect(runs('30 2 * * *', '2011-12-29T00:00:00Z', 'Pacific/Apia', 3)).toEqual([
      '2011-12-29T12:30:00.000Z', // Dec 29 02:30 (-10)
      '2011-12-30T12:30:00.000Z', // Dec 30 does not exist: shifted onto Dec 31 02:30 (+14), once
      '2011-12-31T12:30:00.000Z', // Jan 1 02:30 (+14)
    ])
  })

  it('stays fast (1000 consecutive every-minute lookups)', () => {
    const t0 = performance.now()
    expect(runs('* * * * *', '2026-11-01T00:00:00Z', NY, 1000)).toHaveLength(1000)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

/* ------------------------------------------------------------------------- *
 * Oracle: brute force over every UTC minute around each transition, with the
 * wall time from Intl, and the DST policy applied naively.
 * ------------------------------------------------------------------------- */

const MIN = 60_000
const fmt = new Map<string, Intl.DateTimeFormat>()
function wallOf(tz: string, t: number): number {
  let f = fmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    fmt.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute)
}

function fieldMatch(v: number, field: string, min: number): boolean {
  return field.split(',').some((part) => {
    const [r, st] = part.split('/')
    const step = st === undefined ? 1 : +st
    let lo: number, hi: number
    if (r === '*') { lo = min; hi = Infinity } else if (r.includes('-')) { [lo, hi] = r.split('-').map(Number) } else { lo = +r; hi = st === undefined ? lo : Infinity }
    return v >= lo && v <= hi && (v - lo) % step === 0
  })
}
function wallMatches(expr: string, wall: number): boolean {
  const [m, h, dom, mon, dow] = expr.split(' ')
  const d = new Date(wall)
  if (!fieldMatch(d.getUTCMinutes(), m, 0) || !fieldMatch(d.getUTCHours(), h, 0) || !fieldMatch(d.getUTCMonth() + 1, mon, 1)) return false
  const domOk = fieldMatch(d.getUTCDate(), dom, 1)
  const wd = d.getUTCDay()
  const dowOk = fieldMatch(wd, dow, 0) || (wd === 0 && fieldMatch(7, dow, 0))
  return !dom.startsWith('*') && !dow.startsWith('*') ? domOk || dowOk : domOk && dowOk
}

function oracle(expr: string, tz: string, start: number, end: number, walls: Map<number, number>): number[] {
  const wildcardHour = expr.split(' ')[1].startsWith('*')
  const W = (t: number) => {
    let w = walls.get(t)
    if (w === undefined) { w = wallOf(tz, t); walls.set(t, w) }
    return w
  }
  const out = new Set<number>()
  for (let t = start - 2 * 1440 * MIN; t <= end; t += MIN) {
    const wall = W(t)
    if (wallMatches(expr, wall)) {
      // A fixed hour runs at the first occurrence of its wall time only.
      let first = true
      if (!wildcardHour) for (let k = 1; k <= 26 * 4; k++) if (W(t - k * 15 * MIN) === wall) { first = false; break }
      if (first) out.add(t)
    }
    // A forward jump between t - 1min and t skipped the walls in between.
    const prev = W(t - MIN)
    if (!wildcardHour && wall - prev > MIN) {
      const offsetBefore = prev - (t - MIN)
      for (let skipped = prev + MIN; skipped < wall; skipped += MIN) {
        if (wallMatches(expr, skipped)) out.add(skipped - offsetBefore)
      }
    }
  }
  return [...out].filter((t) => t > start && t <= end).sort((a, b) => a - b)
}

describe('cronNextRun with a time zone: matches a brute-force oracle around transitions', () => {
  const windows: Array<[string, string]> = [
    ['America/New_York', '2026-03-08T07:00:00Z'],
    ['America/New_York', '2026-11-01T06:00:00Z'],
    ['Europe/Madrid', '2026-03-29T01:00:00Z'],
    ['Europe/Madrid', '2026-10-25T01:00:00Z'],
    ['America/Santiago', '2026-09-06T04:00:00Z'],
    ['America/Santiago', '2026-04-05T03:00:00Z'],
    ['Australia/Lord_Howe', '2026-10-03T15:30:00Z'],
    ['Australia/Sydney', '2026-10-03T16:00:00Z'],
    ['Pacific/Apia', '2011-12-30T10:00:00Z'],
    ['UTC', '2026-06-01T00:00:00Z'],
    ['Asia/Kolkata', '2026-06-01T00:00:00Z'],
  ]
  const exprs = ['*/7 * * * *', '0 * * * *', '30 2 * * *', '0 0 * * *', '15 1-3 * * *', '* 2 * * *']

  for (const [tz, center] of windows) {
    it(`${tz} around ${center}`, () => {
      const c = Date.parse(center)
      const start = c - 3 * 1440 * MIN
      const end = c + 3 * 1440 * MIN
      const walls = new Map<number, number>()
      for (const expr of exprs) {
        const expected = oracle(expr, tz, start, end, walls)
        const got: number[] = []
        let at = start
        for (;;) {
          const next = cronNextRun(expr, new Date(at), tz)
          if (!next || next.getTime() > end) break
          expect(next.getTime()).toBeGreaterThan(at)
          got.push(next.getTime())
          at = next.getTime()
        }
        expect(got.map((t) => new Date(t).toISOString()), `${expr} in ${tz}`).toEqual(expected.map((t) => new Date(t).toISOString()))
      }
    }, 60_000)
  }
})
