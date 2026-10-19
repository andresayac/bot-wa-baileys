// Render token for async work that can be superseded (Mermaid.vue: a theme toggle or
// a source change starts a new render while the previous one is still in flight).
// Tested by scripts/smoke/latest-render.test.mjs.

/**
 * `begin()` starts a new run and returns `isCurrent()`, true only while no later
 * `begin()` or `cancel()` happened; a run commits its result only if it is current.
 */
export function latestOnly() {
  let token = 0
  return {
    begin() {
      const mine = ++token
      return () => mine === token
    },
    cancel() {
      token++
    },
  }
}
