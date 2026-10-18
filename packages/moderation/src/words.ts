/**
 * Word / regex filters over message text.
 *
 * Plain strings match case- and diacritic-insensitively (`'Estafa'` matches
 * `'estafá'`), except that `ñ` stays distinct from `n`. By default they match
 * only as whole words, so `'spam'` does not match `'spammer'` unless
 * `wholeWord: false`. RegExps are tested against the raw body exactly as
 * written (their `g`/`y` flags are dropped so tests are stateless).
 */

/**
 * Lowercase and strip diacritics, except the tilde of `ñ`: in Spanish `ñ` is
 * its own letter (`año` is not `ano`), so folding it would make a banned term
 * match unrelated words. Keeps punctuation so word boundaries survive.
 */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .toLowerCase()
    .replace(/n\u0303/g, '\u00f1')
    .replace(/[\u0300-\u036f]/g, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A compiled filter term. */
export interface CompiledTerm {
  /** The original term, for reports (`String(regexp)` for RegExps). */
  label: string
  /** True when the term matches the message. */
  test(raw: string, folded: string): boolean
}

/** Compile banned terms once (at install / config time). */
export function compileTerms(banned: ReadonlyArray<string | RegExp>, wholeWord = true): CompiledTerm[] {
  const out: CompiledTerm[] = []
  for (const term of banned) {
    if (term instanceof RegExp) {
      const re = new RegExp(term.source, term.flags.replace(/[gy]/g, ''))
      out.push({ label: String(term), test: (raw) => re.test(raw) })
      continue
    }
    if (typeof term !== 'string') continue
    const folded = foldText(term).trim()
    if (!folded) continue
    const body = escapeRegExp(folded)
    const re = wholeWord
      ? new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u')
      : new RegExp(body, 'u')
    out.push({ label: term, test: (_raw, f) => re.test(f) })
  }
  return out
}

/** First term that matches `raw`, or `undefined`. */
export function firstMatch(terms: readonly CompiledTerm[], raw: string): CompiledTerm | undefined {
  if (terms.length === 0) return undefined
  const folded = foldText(raw)
  return terms.find((t) => t.test(raw, folded))
}
