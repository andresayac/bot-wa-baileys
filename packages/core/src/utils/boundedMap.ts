/**
 * Bounded-size `Map` helpers.
 *
 * Some caches (e.g. BaileysProvider's LID<->PN identity cache) grow by one pair per resolved
 * identity, forever, with no natural eviction point. `putBounded` caps that growth with a
 * simple insertion-order eviction: `Map` preserves insertion order, so once the map exceeds
 * `max` entries we just drop the oldest ones — no timestamps or access-tracking required.
 */

/**
 * Sets `a -> b` and `b -> a` on `map`, then evicts the oldest entries (in insertion order)
 * until `map.size <= max`. A no-op eviction pass when the map is already within `max`.
 */
export function putBounded(map: Map<string, string>, a: string, b: string, max: number): void {
  map.set(a, b)
  map.set(b, a)
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}
