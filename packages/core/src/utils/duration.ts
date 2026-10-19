const MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|milli|millis|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i

/**
 * Parse a duration into milliseconds. The single grammar every duration option of
 * the bot uses (`'500ms'`, `'90s'`, `'2m'`, `'1h'`, `'1d'`, `'1w'`, long forms such as
 * `'5 minutes'`, or a number / digit string meaning milliseconds).
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input
  const match = DURATION_RE.exec(input.trim())
  if (!match) throw new Error(`Invalid duration: "${input}" — use e.g. '30s', '2m', '1h', '1d' or milliseconds`)
  const value = parseFloat(match[1])
  const unitRaw = (match[2] ?? 'ms').toLowerCase()
  const unit = unitRaw.startsWith('ms') || unitRaw.startsWith('milli') ? 'ms'
    : unitRaw.startsWith('s') ? 's'
    : unitRaw.startsWith('m') ? 'm'
    : unitRaw.startsWith('h') ? 'h'
    : unitRaw.startsWith('d') ? 'd'
    : 'w'
  return Math.round(value * MULTIPLIERS[unit])
}
