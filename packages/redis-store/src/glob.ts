/**
 * Escape Redis glob metacharacters so `KEYS` matches a namespace literally.
 * Without it a prefix such as `bot[1]` matched `bot1:…` keys (another
 * tenant's) and missed its own, and a `*` in a prefix matched any sibling.
 */
export function escapeGlob(literal: string): string {
  return literal.replace(/[*?[\]\\]/g, '\\$&')
}
