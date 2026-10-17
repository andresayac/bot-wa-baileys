/**
 * Minimal, dependency-free semver parsing and range matching for plugin
 * manifests. Supports exact versions, `=`, `>`, `>=`, `<`, `<=`, caret (`^`),
 * tilde (`~`), x-ranges (`2`, `2.x`, `2.1.*`, `*`), space-separated
 * intersections and `||` unions.
 *
 * Differences from npm's `semver`: hyphen ranges (`1.0.0 - 2.0.0`), the `v`
 * prefix and loose parsing are not supported (they are reported as invalid),
 * and prereleases are always ordered by precedence instead of being excluded
 * unless a comparator shares the same `MAJOR.MINOR.PATCH`. Upper bounds use
 * `-0`, so `^2.0.0` never matches `3.0.0-alpha.1`, and `2.0.0-alpha.1` is
 * below `2.0.0`, so `^2.0.0` does not match it either.
 */

type Identifier = string | number

export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: Identifier[]
}

type Operator = '>' | '>=' | '<' | '<='

interface Comparator {
  op: Operator
  version: SemVer
}

const NUM = '0|[1-9]\\d*'
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const BUILD_ID = '[0-9a-zA-Z-]+'
const PRE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?`
const BUILD = `(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?`

const VERSION = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})${PRE}${BUILD}$`)
const XR = `${NUM}|[xX*]`
const COMPARATOR = new RegExp(`^(\\^|~|>=|<=|>|<|=)?(${XR})(?:\\.(${XR})(?:\\.(${XR})${PRE}${BUILD})?)?$`)

/** Parse a full `MAJOR.MINOR.PATCH[-pre][+build]` version, or `undefined` when invalid. */
export function parseVersion(input: string): SemVer | undefined {
  const match = VERSION.exec(input)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: parsePrerelease(match[4]),
  }
}

/**
 * Parse a range into its `||` alternatives (each one an intersection of
 * comparators), or `undefined` when the range is malformed.
 */
export function parseRange(input: string): Comparator[][] | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined
  const sets: Comparator[][] = []
  for (const part of input.split('||')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) return undefined
    const set: Comparator[] = []
    for (const token of tokens) {
      const comparators = parseComparator(token)
      if (!comparators) return undefined
      set.push(...comparators)
    }
    sets.push(set)
  }
  return sets
}

/** `true` when `version` satisfies `range`. Callers validate both first. */
export function satisfies(version: SemVer, range: Comparator[][]): boolean {
  return range.some((set) => set.every((comparator) => test(version, comparator)))
}

/** Semver precedence comparison (build metadata is ignored). */
export function compare(a: SemVer, b: SemVer): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    comparePrerelease(a.prerelease, b.prerelease)
  )
}

function parsePrerelease(raw: string | undefined): Identifier[] {
  if (!raw) return []
  return raw.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
}

function comparePrerelease(a: Identifier[], b: Identifier[]): number {
  // A version without prerelease has higher precedence than one with it.
  if (!a.length || !b.length) return b.length - a.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

function test(version: SemVer, { op, version: bound }: Comparator): boolean {
  const order = compare(version, bound)
  switch (op) {
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
  }
}

function v(major: number, minor: number, patch: number, prerelease: Identifier[] = []): SemVer {
  return { major, minor, patch, prerelease }
}

/** Lowest possible version of a release line: `M.m.p-0`. */
function floor(major: number, minor: number, patch: number): SemVer {
  return v(major, minor, patch, [0])
}

const NOTHING: Comparator[] = [{ op: '<', version: floor(0, 0, 0) }]

/** Desugar one comparator token into primitive `>`/`>=`/`<`/`<=` comparators. */
function parseComparator(token: string): Comparator[] | undefined {
  const match = COMPARATOR.exec(token)
  if (!match) return undefined
  const op = match[1] ?? '='
  const [M, m, p] = [match[2], match[3], match[4]].map((part) =>
    part === undefined || /^[xX*]$/.test(part) ? undefined : Number(part),
  )
  // Once a part is a wildcard, the following parts must be too (`2.x.3` is invalid).
  if (M === undefined && (m !== undefined || p !== undefined)) return undefined
  if (m === undefined && p !== undefined) return undefined
  const prerelease = parsePrerelease(match[5])
  if (prerelease.length && p === undefined) return undefined

  if (M === undefined) return op === '<' || op === '>' ? NOTHING : []

  const lower = v(M, m ?? 0, p ?? 0, prerelease)
  const ge = (version: SemVer): Comparator => ({ op: '>=', version })
  const lt = (version: SemVer): Comparator => ({ op: '<', version })

  switch (op) {
    case '=':
      if (p !== undefined) return [ge(lower), { op: '<=', version: lower }]
      return [ge(lower), lt(m === undefined ? floor(M + 1, 0, 0) : floor(M, m + 1, 0))]
    case '^': {
      let upper: SemVer
      if (M > 0 || m === undefined) upper = floor(M + 1, 0, 0)
      else if (m > 0 || p === undefined) upper = floor(0, m + 1, 0)
      else upper = floor(0, 0, p + 1)
      return [ge(lower), lt(upper)]
    }
    case '~':
      return [ge(lower), lt(m === undefined ? floor(M + 1, 0, 0) : floor(M, m + 1, 0))]
    case '>=':
      return [ge(lower)]
    case '>':
      if (p !== undefined) return [{ op: '>', version: lower }]
      return [ge(m === undefined ? v(M + 1, 0, 0) : v(M, m + 1, 0))]
    case '<':
      if (p !== undefined) return [lt(lower)]
      return [lt(m === undefined ? floor(M, 0, 0) : floor(M, m, 0))]
    case '<=':
      if (p !== undefined) return [{ op: '<=', version: lower }]
      return [lt(m === undefined ? floor(M + 1, 0, 0) : floor(M, m + 1, 0))]
    default:
      return undefined
  }
}
