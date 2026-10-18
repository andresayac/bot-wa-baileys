/**
 * JSONB-safe serialisation for the JSONB columns of {@link PostgresStore}. The
 * user-data table (TEXT) stores values exactly and does not use it (see userData.ts).
 */

/* JSONB encoding ------------------------------------------------------------- *
 * PostgreSQL's jsonb rejects two things a JS string can legally hold: U+0000
 * (the `\u0000` escape, SQLSTATE 22P05) and unpaired UTF-16 surrogates (e.g.
 * text truncated mid-emoji, 22P02). A single one anywhere in a message body or
 * raw payload would make the whole write throw, so both are replaced with
 * U+FFFD. Everything else round-trips unchanged.
 * --------------------------------------------------------------------------- */

/** JSON.stringify emits NUL and lone surrogates as `\uXXXX` escapes (never raw). */
const JSONB_UNSAFE_ESCAPE = /\\u(?:0000|d[89a-f][0-9a-f]{2})/i
const JSONB_UNSAFE_CHAR = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function jsonbSafeString(s: string): string {
  return s.replace(JSONB_UNSAFE_CHAR, String.fromCharCode(0xfffd))
}

function jsonbSafeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return jsonbSafeString(value)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.some((k) => jsonbSafeString(k) !== k)) {
      const rec = value as Record<string, unknown>
      return Object.fromEntries(keys.map((k) => [jsonbSafeString(k), rec[k]]))
    }
  }
  return value
}

/** Serialize a document for a JSONB parameter (see the note above). */
export function toJsonb(value: unknown): string {
  const text = JSON.stringify(value)
  // Fast path: no escape that jsonb could reject. A false positive (a literal
  // backslash followed by "u0000" in some string) only costs the slow path.
  if (!JSONB_UNSAFE_ESCAPE.test(text)) return text
  return JSON.stringify(value, jsonbSafeReplacer)
}
