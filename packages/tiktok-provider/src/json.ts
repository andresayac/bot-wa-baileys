/**
 * Lossless JSON parsing for TikTok webhook payloads.
 *
 * `comment.update` delivers `comment_id` / `video_id` / `parent_comment_id` as
 * bare JSON NUMBERS holding 64-bit ids (e.g. 7247303576418566913), which a
 * plain `JSON.parse` rounds to the nearest double — a corrupted id that can no
 * longer be replied to. Integers outside the safe range are returned as their
 * exact source text instead (JSON.parse source-text access, Node >= 21).
 */

interface ReviverContext { source?: string }
type Reviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown

const keepUnsafeIntegers: Reviver = (_key, value, context) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value)) {
    const source = context?.source
    if (source && /^-?\d+$/.test(source)) return source
  }
  return value
}

/** `JSON.parse` that keeps unsafe integers as exact strings. Throws on invalid JSON. */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, keepUnsafeIntegers as Parameters<typeof JSON.parse>[1])
}

/** Coerce an id that may arrive as number or string to a string (`''` when absent). */
export function idString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
  return ''
}
