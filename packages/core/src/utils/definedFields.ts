/**
 * Copy of `record` without its `undefined`-valued own properties.
 *
 * Stores treat an explicit `undefined` in an upsert as "unset this field"
 * (MemoryStore spread, Mongo `$unset`, SQL key removal), so a partial upsert
 * must omit the fields it does not know instead of sending them as `undefined`
 * — otherwise e.g. a nameless message wipes a previously stored name.
 * `null` is kept: it is an explicit value (handoff clearing uses it).
 */
export function definedFields<T extends object>(record: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}
