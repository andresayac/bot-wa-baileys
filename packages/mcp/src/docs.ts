/**
 * Documentation search over a local docs tree (`docs/` of the monorepo or a checkout the
 * user points at). Powers the optional `docs_search` / `docs_page` tools.
 *
 * Read-only and dependency free: only `.md` files under the configured directory are read,
 * the walk skips generated output (`api/`, `dist/`, `.vitepress/`) and the internal design
 * notes (`superpowers/`), and `readDocPage()` refuses any path that escapes the root.
 * Search is deterministic: accent- and case-insensitive term matching over headings and
 * section bodies, weighted by inverse document frequency so a rare identifier (`appendLog`)
 * outranks a word that appears on every page (`durabilidad`). No ranking model, no fuzzy
 * guessing.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** Directories never indexed: generated output and internal design notes. */
const SKIP_DIRS = new Set(['node_modules', 'api', 'dist', '.vitepress', 'superpowers'])

/** Files larger than this are skipped (a single guide is a few tens of KiB). */
const MAX_FILE_BYTES = 512 * 1024

/**
 * Function words ignored while ranking (English and Spanish). A query made only of these is
 * still searched, so `"how to"` is not silently empty.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then', 'there', 'these', 'this', 'to', 'was',
  'what', 'when', 'where', 'which', 'why', 'with', 'you', 'your',
  'al', 'algo', 'como', 'con', 'cual', 'de', 'del', 'el', 'en', 'es', 'esa', 'ese', 'eso', 'esta', 'este', 'esto',
  'hay', 'la', 'las', 'lo', 'los', 'mas', 'mi', 'o', 'para', 'pero', 'por', 'que', 'se', 'si', 'sin', 'su', 'sus',
  'un', 'una', 'uno', 'y', 'ya',
])

/** `docs_page` truncates here instead of returning a multi-megabyte wall of text. */
const MAX_PAGE_CHARS = 120_000

/** One heading-delimited chunk of a markdown file. */
export interface DocSection {
  /** Path relative to the docs root, with `/` separators. */
  path: string
  /** First heading of the file (the page title). */
  title: string
  /** Heading this chunk belongs to. */
  heading: string
  /** Markdown body of the chunk (without the heading line). */
  body: string
}

/** One search result. */
export interface DocHit {
  path: string
  title: string
  heading: string
  snippet: string
  score: number
}

/** Lowercase and strip diacritics, so `traza` finds «Trazas» and `durabilidad` finds «Durabilidad». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function termsOf(query: string): string[] {
  return fold(query)
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1)
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0 && count < 1_000) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Split a markdown file at its headings, ignoring `#` lines inside fenced code blocks. */
export function parseSections(path: string, markdown: string): DocSection[] {
  const lines = markdown.split(/\r?\n/)
  const sections: DocSection[] = []
  let title: string | undefined
  let heading: string | undefined
  let body: string[] = []
  let fenced = false

  const flush = (): void => {
    if (heading === undefined && body.every((line) => line.trim() === '')) return
    sections.push({ path, title: title ?? path, heading: heading ?? title ?? path, body: body.join('\n').trim() })
    body = []
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      heading = match[2]!
      title ??= heading
      continue
    }
    body.push(line)
  }
  flush()
  return sections.filter((section) => section.heading !== path || section.body !== '')
}

/** Every `.md` file under `root`, as `/`-separated relative paths, sorted. */
export async function markdownFiles(root: string): Promise<string[]> {
  const absolute = resolve(root)
  const out: string[] = []

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      out.push(relative(absolute, full).split(sep).join('/'))
    }
  }

  await walk(absolute)
  return out.sort()
}

/** Read and split every markdown file of a docs tree. */
export async function loadSections(root: string): Promise<DocSection[]> {
  const files = await markdownFiles(root)
  const sections: DocSection[] = []
  for (const path of files) {
    const markdown = await readFile(resolve(root, path), 'utf8')
    if (markdown.length > MAX_FILE_BYTES) continue
    sections.push(...parseSections(path, markdown))
  }
  return sections
}

/** Trim a matching line to a readable snippet around the first hit. */
function snippetOf(body: string, terms: readonly string[]): string {
  const lines = body.split(/\r?\n/)
  const folded = lines.map(fold)
  let index = folded.findIndex((line) => terms.some((term) => line.includes(term)))
  if (index < 0) index = folded.findIndex((line) => line.trim() !== '')
  const line = (lines[index] ?? '').trim()
  return line.length <= 220 ? line : `${line.slice(0, 217)}…`
}

/**
 * Rank sections against a query.
 *
 * Every term is weighted by inverse document frequency (a term present in many sections is
 * worth less) and scored by **presence**, not raw count: five mentions of a common word in
 * one section must not beat one mention of the identifier the caller is looking for. A
 * heading hit doubles the term, a few extra mentions add a small bonus (capped), every
 * matched term adds a coverage point and an exact phrase wins over scattered words. Sections
 * are visited in file order, so equal scores stay stable.
 */
export function searchSections(sections: readonly DocSection[], query: string, limit = 8): DocHit[] {
  const allTerms = termsOf(query)
  const meaningful = allTerms.filter((term) => !STOPWORDS.has(term))
  const terms = meaningful.length > 0 ? meaningful : allTerms
  if (terms.length === 0) return []
  const phrase = fold(query).trim()
  const total = Math.max(1, sections.length)

  const folded = sections.map((section) => ({
    section,
    heading: fold(`${section.heading} ${section.title}`),
    body: fold(section.body),
  }))

  // Document frequency of each query term (how many sections mention it at all).
  const frequency = new Map<string, number>()
  for (const term of terms) {
    let count = 0
    for (const entry of folded) if (entry.heading.includes(term) || entry.body.includes(term)) count++
    frequency.set(term, count)
  }
  const idf = (term: string): number => Math.log(1 + total / (1 + (frequency.get(term) ?? 0)))

  const hits: Array<DocHit & { order: number }> = []
  folded.forEach(({ section, heading, body }, order) => {
    let score = 0
    let matched = 0
    for (const term of terms) {
      const inHeading = countOccurrences(heading, term)
      const inBody = countOccurrences(body, term)
      if (inHeading + inBody === 0) continue
      matched++
      // Presence first; the heading flag and a capped repetition bonus only refine the order.
      const reach = (inHeading > 0 ? 2 : 1) * (1 + Math.min(inBody, 3) * 0.25)
      score += idf(term) * reach
    }
    if (matched === 0) return
    score += matched
    if (phrase.length > 3 && body.includes(phrase)) score += 6
    hits.push({
      path: section.path,
      title: section.title,
      heading: section.heading,
      snippet: snippetOf(section.body, terms),
      score: Math.round(score * 100) / 100,
      order,
    })
  })

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.order - b.order)
  return hits.slice(0, Math.max(1, limit)).map(({ order: _order, ...hit }) => hit)
}

/** Search a docs tree in one call (walks the directory; no cache to go stale). */
export async function searchDocs(root: string, query: string, limit = 8): Promise<DocHit[]> {
  return searchSections(await loadSections(root), query, limit)
}

/**
 * Read one documentation page by its path relative to the docs root.
 * @throws when the path escapes the root, is not markdown or does not exist.
 */
export async function readDocPage(root: string, requested: string): Promise<{ path: string; text: string; truncated: boolean }> {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, requested)
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`path escapes the docs directory: ${requested}`)
  }
  if (!target.endsWith('.md')) throw new Error(`only .md files can be read: ${requested}`)
  const raw = await readFile(target, 'utf8')
  const truncated = raw.length > MAX_PAGE_CHARS
  return {
    path: relative(absoluteRoot, target).split(sep).join('/'),
    text: truncated ? `${raw.slice(0, MAX_PAGE_CHARS)}\n\n… [truncated]` : raw,
    truncated,
  }
}
