/**
 * Minimal semver for the packaging smoke test — only what our ranges use:
 * exact, `^`, `~`, `>=`/`>`/`<=`/`<`, `||`, space-separated AND, `*`.
 *
 * Prereleases follow npm's rule: a prerelease version only satisfies a range
 * if some comparator in the same `||` alternative names a prerelease on the
 * same major.minor.patch tuple (so `0.1.1-alpha.0` does NOT satisfy
 * `^0.1.0`). Without this, the smoke test would report template ranges as
 * resolving when a real `npm install` would not.
 */

export function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) return undefined
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

export function cmpVer(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k]
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && +x !== +y) return +x - +y
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const sameTuple = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch

/** Does `version` satisfy `range`, as npm would resolve it? */
export function satisfies(version, range) {
  const v = parseVer(version)
  if (!v) return false
  return String(range)
    .split('||')
    .some((alt) => {
      const comparators = alt.trim().split(/\s+/).filter(Boolean)
      if (!comparators.length) comparators.push('*')
      let preAllowed = v.pre.length === 0
      const ok = comparators.every((c) => {
        const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(c)
        const op = m?.[1] ?? '='
        const r = parseVer(m?.[2] ?? '')
        if (!r) return c === '*' || c === 'x' || c === 'latest'
        if (r.pre.length && sameTuple(v, r)) preAllowed = true
        const d = cmpVer(v, r)
        if (op === '=') return d === 0
        if (op === '>=') return d >= 0
        if (op === '>') return d > 0
        if (op === '<=') return d <= 0
        if (op === '<') return d < 0
        if (d < 0) return false
        if (op === '~') return v.major === r.major && v.minor === r.minor
        // ^: same left-most non-zero component
        if (r.major > 0) return v.major === r.major
        if (r.minor > 0) return v.major === 0 && v.minor === r.minor
        return v.major === 0 && v.minor === 0 && v.patch === r.patch
      })
      return ok && preAllowed
    })
}
