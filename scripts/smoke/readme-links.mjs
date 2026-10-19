/**
 * Relative links in a README break once it is rendered on npmjs.com (there is
 * no repository tree next to it), so shipped READMEs must use absolute URLs.
 */

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i

/** Every link target in `markdown` that is not absolute (http(s), mailto, anchors...). */
export function relativeLinks(markdown) {
  const text = String(markdown)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
  const found = []
  const patterns = [
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, // [text](target), ![alt](target)
    /^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm, // [ref]: target
    /<(?:a|img|source)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi, // <a href>, <img src>
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.push({ at: m.index, target: m[1] })
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.target)
    .filter((t) => !ABSOLUTE.test(t))
}
