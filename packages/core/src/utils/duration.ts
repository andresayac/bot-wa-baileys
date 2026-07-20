const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Parse '500ms' | '90s' | '2m' | '1h' | number(ms) → milliseconds. */
export function parseDuration(d: string | number): number {
  if (typeof d === 'number') return d
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(d.trim())
  if (!m) throw new Error(`Invalid duration: "${d}" — use e.g. '30s', '2m', '1h' or milliseconds`)
  return Math.round(parseFloat(m[1]) * UNITS[m[2]])
}
