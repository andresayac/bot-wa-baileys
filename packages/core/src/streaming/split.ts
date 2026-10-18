/**
 * Text splitting for transports with a per-message length limit. Prefers the
 * most natural boundary: paragraph, line, sentence, word, then a hard cut (which
 * never separates a UTF-16 surrogate pair).
 */

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*\s/g

/** Never cut between a high and a low surrogate. */
function safeCut(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return at
  const code = text.charCodeAt(at - 1)
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at
}

function lastSentenceEnd(window: string, from: number, upTo = Infinity): number {
  let best = -1
  SENTENCE_END.lastIndex = 0
  for (let m = SENTENCE_END.exec(window); m; m = SENTENCE_END.exec(window)) {
    const end = m.index + m[0].length
    if (end >= from && end <= upTo) best = end
  }
  return best
}

/**
 * Index where `text` should be cut so the head fits in `max` chars. Returns
 * `text.length` when it already fits.
 */
export function findSplitPoint(text: string, max: number): number {
  if (text.length <= max) return text.length
  const window = text.slice(0, max + 1)
  const floor = Math.floor(max * 0.3)
  const para = window.lastIndexOf('\n\n')
  if (para >= floor && para > 0) return para + 2 <= max ? para + 2 : para
  const line = window.lastIndexOf('\n')
  if (line >= floor && line > 0) return line + 1 <= max ? line + 1 : line
  const sentence = lastSentenceEnd(window, floor, max)
  if (sentence > 0) return sentence
  const space = window.lastIndexOf(' ')
  if (space >= floor && space > 0) return space + 1 <= max ? space + 1 : space
  return Math.max(1, safeCut(text, max))
}

/**
 * Split `text` into pieces of at most `max` chars at natural boundaries. Pieces
 * are trimmed; whitespace-only pieces are dropped.
 *
 * @example
 * ```ts
 * for (const part of splitMessage(longText, 4096)) await ctx.reply(part)
 * ```
 */
export function splitMessage(text: string, max: number): string[] {
  if (!(max > 0)) throw new RangeError(`splitMessage: max must be > 0, got ${max}`)
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = findSplitPoint(rest, max)
    const head = rest.slice(0, cut).trimEnd()
    if (head) out.push(head)
    rest = rest.slice(cut).trimStart()
  }
  const tail = rest.trim()
  if (tail) out.push(tail)
  return out
}

/**
 * End index of the last sentence boundary in `text` at or after `minChars`
 * (paragraph/line breaks count), or -1. Used by the `'chunk'` strategy.
 */
export function lastBoundaryAfter(text: string, minChars: number): number {
  let best = lastSentenceEnd(text, minChars)
  const line = text.lastIndexOf('\n')
  if (line >= 0 && line + 1 >= minChars && line + 1 > best) best = line + 1
  return best
}
