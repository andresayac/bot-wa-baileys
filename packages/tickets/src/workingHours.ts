/**
 * Working-hours parsing and evaluation for the tickets plugin.
 *
 * Accepted shapes (`TicketsPluginConfig.workingHours`):
 *  - `'9-18'`, `'09:30-18:15'` — one window, every day of the week;
 *  - `{ days?: number[], start: 'HH:mm' | hour, end: 'HH:mm' | hour }` — `days` uses
 *    `Date#getDay()` numbering (0 = Sunday … 6 = Saturday), default every day;
 *  - an array of the above (several windows, e.g. split shifts);
 *  - `(date) => boolean` — a custom predicate, used as-is.
 *
 * Windows are evaluated in an IANA timezone (default: the process timezone). The end is
 * exclusive. A window whose end is before its start wraps past midnight (`'22-6'`); its
 * early-morning part belongs to the day the window started.
 */

/** One working-hours window as accepted in config. */
export interface WorkingHoursWindow {
  /** Days of the week (0 = Sunday … 6 = Saturday). Default: every day. */
  days?: number[]
  /** Opening time: `'HH:mm'` or a whole hour (`9`). */
  start: string | number
  /** Closing time (exclusive): `'HH:mm'` or a whole hour (`18`). */
  end: string | number
}

/** Custom predicate form of {@link WorkingHoursInput}. */
export type WorkingHoursPredicate = (date: Date) => boolean

/** Everything `workingHours` accepts. */
export type WorkingHoursInput = string | WorkingHoursWindow | WorkingHoursWindow[] | WorkingHoursPredicate

/** A normalized window: minutes since midnight. */
export interface NormalizedWindow {
  days: number[]
  start: number
  end: number
}

/** Parsed working hours: normalized windows or a predicate. */
export type WorkingHours = NormalizedWindow[] | WorkingHoursPredicate

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

function invalid(detail: string): Error {
  return new Error(`Invalid tickets config.workingHours: ${detail}`)
}

function parseTime(value: string | number, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 24) throw invalid(`${field} must be an hour 0-24, got ${value}`)
    return value * 60
  }
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(value)
  if (!m) throw invalid(`${field} must look like "HH:mm", got ${JSON.stringify(value)}`)
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw invalid(`${field} out of range: ${JSON.stringify(value)}`)
  return h * 60 + min
}

function parseWindow(w: WorkingHoursWindow): NormalizedWindow {
  if (!w || typeof w !== 'object') throw invalid('each window must be an object')
  const days = w.days ?? ALL_DAYS
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw invalid('days must be a non-empty array of integers 0 (Sunday) … 6 (Saturday)')
  }
  const start = parseTime(w.start, 'start')
  const end = parseTime(w.end, 'end')
  if (start === end) throw invalid('start and end must differ')
  return { days: [...new Set(days)].sort((a, b) => a - b), start, end }
}

/** Normalize a `workingHours` config value. Throws on malformed input. */
export function parseWorkingHours(input: WorkingHoursInput): WorkingHours {
  if (typeof input === 'function') return input
  if (typeof input === 'string') {
    const m = /^\s*([\d:]+)\s*-\s*([\d:]+)\s*$/.exec(input)
    if (!m) throw invalid(`expected "start-end" such as "9-18", got ${JSON.stringify(input)}`)
    return [parseWindow({ start: m[1], end: m[2] })]
  }
  if (Array.isArray(input)) {
    if (input.length === 0) throw invalid('the window list is empty')
    return input.map(parseWindow)
  }
  return [parseWindow(input)]
}

const formatters = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Day of week + minutes since midnight of `date` in `timeZone` (undefined → process timezone). */
export function localClock(date: Date, timeZone?: string): { day: number; minutes: number } {
  const key = timeZone ?? ''
  let fmt = formatters.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatters.set(key, fmt)
  }
  let day = 0
  let hour = 0
  let minute = 0
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'weekday') day = WEEKDAYS[p.value] ?? 0
    else if (p.type === 'hour') hour = Number(p.value) % 24
    else if (p.type === 'minute') minute = Number(p.value)
  }
  return { day, minutes: hour * 60 + minute }
}

/** Whether `date` falls inside the working hours (evaluated in `timeZone`). */
export function isWithinWorkingHours(hours: WorkingHours, date: Date, timeZone?: string): boolean {
  if (typeof hours === 'function') return hours(date)
  const { day, minutes } = localClock(date, timeZone)
  const yesterday = (day + 6) % 7
  return hours.some((w) => {
    if (w.start < w.end) return w.days.includes(day) && minutes >= w.start && minutes < w.end
    // overnight window
    return (w.days.includes(day) && minutes >= w.start) || (w.days.includes(yesterday) && minutes < w.end)
  })
}
