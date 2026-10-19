/**
 * Cron in an IANA time zone (internal): the five cron fields are read as wall-clock time
 * in `timeZone`, with Intl only (no tz database dependency). `cron.ts` keeps the legacy
 * host-local evaluation; this module is used when a task (or its scheduler) sets a zone.
 *
 * Daylight-saving policy (also in the scheduler guide). The hour field is a "wildcard"
 * when it starts with `*` (`*`, `*` + `/2`), the same rule the day fields use:
 * - Gap (a local time that does not exist, spring forward): a fixed-hour slot runs once,
 *   shifted forward by the length of the gap (02:30 → 03:30; RFC 5545 / Temporal
 *   `disambiguation: 'compatible'`); wildcard-hour slots inside the gap are dropped.
 * - Overlap (a local time that occurs twice, fall back): a fixed-hour slot runs once, at
 *   the first occurrence; wildcard-hour slots run in both passes (distinct instants).
 * - A shifted slot that lands on another slot's instant runs once. Run instants are
 *   strictly increasing.
 *
 * Cost: days far from a transition take one cached offset per day; a transition day
 * builds (and caches) an offset profile whose transitions are found by bisection, so
 * resolving its candidates needs no further Intl calls.
 */

import { matchesField, matchesWeekday } from './cron.js'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Search horizon: four years (a leap day) plus the days a gap shift can move a slot. */
const HORIZON_DAYS = 4 * 366 + 2
const MAX_FORMATTERS = 64
const MAX_DAY_INFOS = 1024

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (f) return f
  f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value as string)
  formatters.set(timeZone, f)
  return f
}

/**
 * Throw when `timeZone` is not usable: a `TypeError` for a non-string, a `RangeError` for
 * an empty name, whitespace, control characters or a zone Intl does not know. `'local'`
 * (the process zone) is accepted. `what` names the task in the message.
 */
export function assertTimeZone(timeZone: unknown, what: string): asserts timeZone is string {
  if (typeof timeZone !== 'string') {
    throw new TypeError(`${what}: timeZone must be an IANA zone name such as 'America/Bogota' (or 'local'), got ${JSON.stringify(timeZone)}`)
  }
  if (timeZone === 'local') return
  if (timeZone === '' || /[\s\u0000-\u001f\u007f]/.test(timeZone)) {
    throw new RangeError(`${what}: invalid timeZone ${JSON.stringify(timeZone)}`)
  }
  try {
    formatter(timeZone)
  } catch {
    throw new RangeError(`${what}: unknown timeZone ${JSON.stringify(timeZone)} (use an IANA name such as 'Europe/Madrid', 'UTC' or 'local')`)
  }
}

/** UTC offset (ms) of `timeZone` at instant `t`: wall time (as naive UTC ms) minus the instant. */
export function offsetAt(timeZone: string, t: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(t))
  let y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0
  for (const p of parts) {
    switch (p.type) {
      case 'year': y = Number(p.value); break
      case 'month': mo = Number(p.value); break
      case 'day': d = Number(p.value); break
      case 'hour': h = Number(p.value) % 24; break
      case 'minute': mi = Number(p.value); break
      case 'second': s = Number(p.value); break
    }
  }
  // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear does not.
  const wall = new Date(Date.UTC(2000, mo - 1, d, h, mi, s)).setUTCFullYear(y)
  return wall - Math.floor(t / SECOND) * SECOND
}

/**
 * Offsets of one zone over a window: `offsets[i]` applies from `starts[i]` (inclusive)
 * to `starts[i + 1]`. Outside `[from, to]` it falls back to Intl.
 */
interface OffsetProfile {
  from: number
  to: number
  starts: number[]
  offsets: number[]
}

function buildProfile(timeZone: string, from: number, to: number): OffsetProfile {
  const starts = [from]
  const offsets = [offsetAt(timeZone, from)]
  let prevT = from
  let prevO = offsets[0]
  for (let t = from + 3 * HOUR; t <= to; t = Math.min(t + 3 * HOUR, to)) {
    const o = offsetAt(timeZone, t)
    if (o !== prevO) {
      // Bisect (to the second) the first instant with the new offset.
      let lo = prevT
      let hi = t
      while (hi - lo > SECOND) {
        const mid = lo + Math.floor((hi - lo) / 2 / SECOND) * SECOND
        if (offsetAt(timeZone, mid) === prevO) lo = mid
        else hi = mid
      }
      starts.push(hi)
      offsets.push(o)
    }
    prevT = t
    prevO = o
    if (t === to) break
  }
  return { from, to, starts, offsets }
}

function profileOffset(timeZone: string, p: OffsetProfile, t: number): number {
  if (t < p.from || t > p.to) return offsetAt(timeZone, t)
  let i = p.starts.length - 1
  while (i > 0 && p.starts[i] > t) i--
  return p.offsets[i]
}

/** Per (zone, local day): a steady offset, or the profile of the transition near it. */
type DayInfo = { steady: number } | { profile: OffsetProfile }
const dayInfos = new Map<string, DayInfo>()

function dayInfo(timeZone: string, day: number): DayInfo {
  const key = `${timeZone}\u0000${day}`
  const cached = dayInfos.get(key)
  if (cached) return cached
  // Offsets sampled every 6 h over [day - 1d, day + 2d]: equal means no transition near the day.
  const first = offsetAt(timeZone, day - DAY)
  let steady = true
  for (let t = day - DAY + 6 * HOUR; t <= day + 2 * DAY; t += 6 * HOUR) {
    if (offsetAt(timeZone, t) !== first) {
      steady = false
      break
    }
  }
  const info: DayInfo = steady ? { steady: first } : { profile: buildProfile(timeZone, day - 2 * DAY, day + 3 * DAY) }
  if (dayInfos.size >= MAX_DAY_INFOS) dayInfos.delete(dayInfos.keys().next().value as string)
  dayInfos.set(key, info)
  return info
}

/** Resolution of one wall time. */
interface Resolved {
  /** 1 instant (normal), 2 (overlap, earlier first), or empty (gap). */
  instants: number[]
  /** In a gap: the wall time read with the pre-transition offset (shifted forward by the gap). */
  shifted: number
}

/** Resolve a wall time `W` (naive UTC ms) with the offset function `off`. */
function resolveWith(off: (t: number) => number, W: number): Resolved {
  const o1 = off(W - DAY)
  const o2 = off(W + DAY)
  const instants: number[] = []
  for (const o of o1 === o2 ? [o1] : [o1, o2]) {
    const t = W - o
    if (t + off(t) === W && !instants.includes(t)) instants.push(t)
  }
  instants.sort((a, b) => a - b)
  return { instants, shifted: W - o1 }
}

/** Resolve a wall time `W` (naive UTC ms) in `timeZone`. */
export function resolveWall(timeZone: string, W: number): Resolved {
  return resolveWith((t) => offsetAt(timeZone, t), W)
}

/** Parsed five-field expression, with the minute/hour matches precomputed. */
interface ParsedCron {
  minutes: number[]
  hours: number[]
  wildcardHour: boolean
  dom: string
  mon: string
  dow: string
  orDays: boolean
}

const parsedCache = new Map<string, ParsedCron>()

function parse(expr: string): ParsedCron | null {
  const cached = parsedCache.get(expr)
  if (cached) return cached
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts
  const parsed: ParsedCron = {
    minutes: range(60).filter((v) => matchesField(v, m, 0)),
    hours: range(24).filter((v) => matchesField(v, h, 0)),
    wildcardHour: h.startsWith('*'),
    dom,
    mon,
    dow,
    orDays: !dom.startsWith('*') && !dow.startsWith('*'),
  }
  if (parsedCache.size >= 256) parsedCache.delete(parsedCache.keys().next().value as string)
  parsedCache.set(expr, parsed)
  return parsed
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function dayMatches(c: ParsedCron, day: number): boolean {
  const d = new Date(day)
  if (!matchesField(d.getUTCMonth() + 1, c.mon, 1)) return false
  const domOk = matchesField(d.getUTCDate(), c.dom, 1)
  const dowOk = matchesWeekday(d.getUTCDay(), c.dow)
  return c.orDays ? domOk || dowOk : domOk && dowOk
}

/**
 * The first instant strictly after `from` at which `expr` fires in `timeZone` (see the
 * module doc for the DST rules), or `null` when nothing matches within four years.
 */
export function nextRunInZone(expr: string, from: Date, timeZone: string): Date | null {
  const c = parse(expr)
  if (!c || c.minutes.length === 0 || c.hours.length === 0) return null
  const after = from.getTime()
  const wallFrom = after + offsetAt(timeZone, after)
  // A gap shift moves a slot forward by up to a day: start from the previous local day.
  const firstDay = Math.floor(wallFrom / DAY) * DAY - DAY
  let best: number | undefined
  let bestDay = 0
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = firstDay + i * DAY
    if (best !== undefined && day > bestDay + DAY) break
    if (!dayMatches(c, day)) continue
    // Skip a whole day that cannot beat `from` (its latest wall time, read with the
    // smallest offset plus a day of shift, is still before it).
    if (day + 2 * DAY + 14 * HOUR < after) continue
    const info = dayInfo(timeZone, day)
    const profile = 'profile' in info ? info.profile : undefined
    const off = profile ? (t: number) => profileOffset(timeZone, profile, t) : undefined
    for (const h of c.hours) {
      for (const m of c.minutes) {
        const W = day + h * HOUR + m * MINUTE
        let candidates: number[]
        if (!off) {
          candidates = [W - (info as { steady: number }).steady]
        } else {
          const r = resolveWith(off, W)
          if (r.instants.length === 0) candidates = c.wildcardHour ? [] : [r.shifted]
          else candidates = c.wildcardHour ? r.instants : [r.instants[0]]
        }
        for (const t of candidates) {
          if (t > after && (best === undefined || t < best)) {
            best = t
            bestDay = day
          }
        }
      }
    }
  }
  return best === undefined ? null : new Date(best)
}
