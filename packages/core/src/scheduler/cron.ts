/* =============================================================================
 * MINIMAL CRON PARSER — five fields: minute hour day-of-month month weekday.
 * Each field takes '*', a number, a range (1-5), a step (`*` + `/15`, 1-30/5, 5/15) or a
 * comma list of those; weekday 0 and 7 are Sunday. A `*` step counts from the field's
 * minimum (`*` + `/2` in day-of-month = 1, 3, 5…; `*` + `/3` in month = Jan, Apr, Jul, Oct).
 * Day rule of standard (Vixie) cron: when BOTH day-of-month and weekday are restricted,
 * a day matches if EITHER does (`0 9 13 * 5` = every 13th and every Friday); when one
 * of them starts with `*` (including a `*` step), both must match. Names (mon, jan)
 * and macros (@daily) are rejected when the task is created.
 * (For full cron support, swap to a real parser like `cron-parser`.)
 * ========================================================================== */

const CRON_FIELDS = ['minute', 'hour', 'day-of-month', 'month', 'weekday'] as const
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/

/** Throw an actionable `TypeError` for an expression the minimal parser cannot run. */
export function assertCron(expr: string): void {
  const parts = typeof expr === 'string' ? expr.trim().split(/\s+/) : []
  if (parts.length !== 5) {
    throw new TypeError(
      `Invalid cron expression "${String(expr)}": expected 5 fields (minute hour day-of-month month weekday), e.g. '0 9 * * 1-5'`,
    )
  }
  parts.forEach((part, i) => {
    if (!CRON_FIELD.test(part)) {
      throw new TypeError(
        `Invalid cron expression "${expr}": the ${CRON_FIELDS[i]} field "${part}" must use numbers, '*', ranges (1-5), steps (*/15) or lists (1,15)`,
      )
    }
  })
}

/**
 * The first minute strictly after `from` (default: now) that matches `expr`, or `null`
 * when nothing matches within a year. Pure for a given `from` (cron fields are local time).
 */
export function cronNextRun(expr: string, from: Date = new Date()): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts

  // Start from next minute
  const next = new Date(from.getTime())
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  // Standard cron: a day field starting with '*' (even a step such as '*/2') is "unrestricted".
  const orDays = !dom.startsWith('*') && !dow.startsWith('*')

  // Search far enough to cover monthly and annual expressions.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const candidate = new Date(next.getTime() + i * 60_000)
    if (!matchesField(candidate.getMinutes(), m, 0) ||
        !matchesField(candidate.getHours(), h, 0) ||
        !matchesField(candidate.getMonth() + 1, mon, 1)) continue
    const domOk = matchesField(candidate.getDate(), dom, 1)
    const dowOk = matchesWeekday(candidate.getDay(), dow)
    if (orDays ? domOk || dowOk : domOk && dowOk) return candidate
  }
  return null
}

/** Weekday field: `0` and `7` both mean Sunday (standard cron). */
function matchesWeekday(day: number, expr: string): boolean {
  return matchesField(day, expr, 0) || (day === 0 && matchesField(7, expr, 0))
}

/** Does `actual` match one cron field? `min` is the field's lowest value (where a `*` step starts). */
function matchesField(actual: number, expr: string, min: number): boolean {
  if (expr === '*') return true
  // ranges & lists
  for (const part of expr.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : parseInt(stepText, 10)
    if (!Number.isInteger(step) || step <= 0) continue
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = Number.POSITIVE_INFINITY
    } else if (range.includes('-')) {
      ;[lo, hi] = range.split('-').map((n) => parseInt(n, 10))
    } else {
      lo = parseInt(range, 10)
      // `5/15` (start/step without a range) runs from 5 to the end of the field.
      hi = stepText === undefined ? lo : Number.POSITIVE_INFINITY
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue
    if (actual >= lo && actual <= hi && (actual - lo) % step === 0) return true
  }
  return false
}
