/**
 * Markdown → channel text formatting for AI replies.
 *
 * Models answer in Markdown (`**bold**`, `# heading`, `[link](url)`, `- item`),
 * but most chat channels do not render it: WhatsApp has its own markup
 * (`*bold*`, `_italic_`, `~strike~`), Telegram (sent without `parse_mode`),
 * Messenger and Instagram show the markers literally. {@link formatMarkdown}
 * converts a reply to the dialect of the chat (`ctx.textFormat`: the
 * provider's per-chat `textFormatFor`, else its `capabilities.textFormat`); {@link formatMarkdownStream} does the same for a
 * streamed reply, emitting each piece as soon as its markers are complete.
 */
import type { TextFormat } from '@bot-wa/core'

export type { TextFormat }

/** Options of {@link formatMarkdown}. */
export interface FormatMarkdownOptions {
  /** The text continues a line started by a previous piece: its first line is not a heading/bullet. */
  continuation?: boolean
}

const FENCE_LINE = /^[ \t]*```/
const PLACEHOLDER = /\u0000(\d+)\u0000/g
const MARK = { bold: '\u0001', strike: '\u0002', italic: '\u0003' } as const
type Emphasis = keyof typeof MARK

const WA_MARK: Record<Emphasis, string> = { bold: '*', strike: '~', italic: '_' }
const HTML_TAG: Record<Emphasis, string> = { bold: 'b', strike: 's', italic: 'i' }

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** An (already text-escaped) URL inside a double-quoted `href`: a `"` must not close the attribute. */
const hrefOf = (url: string): string => url.replace(/"/g, '&quot;')

/** Inline Markdown of one line fragment (no code spans inside). */
function inlineText(text: string, format: Exclude<TextFormat, 'markdown'>, opts: { noBold?: boolean } = {}): string {
  const saved: string[] = []
  const keep = (s: string): string => `\u0000${saved.push(s) - 1}\u0000`
  let s = format === 'html' ? escapeHtml(text) : text
  // Images and links first, then bare URLs: their characters (_ * ~) are never emphasis.
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) =>
    keep(format === 'html' ? `<a href="${hrefOf(url)}">${alt || url}</a>` : url))
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    if (format === 'html') return keep(`<a href="${hrefOf(url)}">${inlineText(label, 'plain')}</a>`)
    const shown = inlineText(label, format)
    return keep(shown === url ? url : `${shown} (${url})`)
  })
  s = s.replace(/\bhttps?:\/\/[^\s<>()"]+/g, (url) => keep(url))
  const wrap = (kind: Emphasis) => (_m: string, pre: string, body: string): string => {
    if (kind === 'bold' && opts.noBold) return pre + body
    if (format === 'html') return `${pre}<${HTML_TAG[kind]}>${body}</${HTML_TAG[kind]}>`
    return pre + MARK[kind] + body + MARK[kind]
  }
  s = s.replace(/(^|[^*\\])\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)/g, wrap('bold'))
  s = s.replace(/(^|[^\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, wrap('bold'))
  s = s.replace(/(^|[^~])~~(?=\S)(.+?)(?<=\S)~~(?!~)/g, wrap('strike'))
  s = s.replace(/(^|[^\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, wrap('italic'))
  s = s.replace(/(^|[^\w\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, wrap('italic'))
  s = s.replace(/[\u0001\u0002\u0003]/g, (m) => {
    if (format !== 'whatsapp') return ''
    const kind = (Object.keys(MARK) as Emphasis[]).find((k) => MARK[k] === m)!
    return WA_MARK[kind]
  })
  return s.replace(PLACEHOLDER, (_m, i: string) => saved[Number(i)] ?? '')
}

/** Inline Markdown of a line, keeping `code` spans verbatim (WhatsApp), bare (plain) or as <code> (html). */
function inlineLine(line: string, format: Exclude<TextFormat, 'markdown'>, opts: { noBold?: boolean } = {}): string {
  let out = ''
  let last = 0
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    out += inlineText(line.slice(last, m.index), format, opts)
    const code = m[1] ?? ''
    out += format === 'whatsapp' ? m[0] : format === 'html' ? `<code>${escapeHtml(code)}</code>` : code
    last = m.index + m[0].length
  }
  return out + inlineText(line.slice(last), format, opts)
}

function blockLine(line: string, format: Exclude<TextFormat, 'markdown'>, startsLine: boolean): string {
  if (startsLine) {
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return ''
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const body = inlineLine(heading[1] ?? '', format, { noBold: true })
      if (!body) return ''
      return format === 'whatsapp' ? `*${body}*` : format === 'html' ? `<b>${body}</b>` : body
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) return `${bullet[1] ?? ''}• ${inlineLine(bullet[2] ?? '', format)}`
  }
  return inlineLine(line, format)
}

/**
 * Convert Markdown to the dialect of a channel (`ctx.textFormat`):
 * `'whatsapp'` (`*bold*`, `_italic_`, `~strike~`, `•` bullets, headings in
 * bold, links as `text (url)`), `'plain'` (markers stripped), `'html'` (a small
 * escaped subset: `<b> <i> <s> <code> <pre> <a>`) or `'markdown'` (unchanged).
 * Code spans and fenced blocks are never reformatted; `snake_case` words and
 * arithmetic like `2 * 3` are left alone.
 */
export function formatMarkdown(text: string, format: TextFormat, opts: FormatMarkdownOptions = {}): string {
  if (format === 'markdown' || !text) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string[] | undefined
  lines.forEach((line, i) => {
    if (FENCE_LINE.test(line)) {
      if (fence === undefined) {
        fence = []
        if (format === 'whatsapp') out.push(line)
        return
      }
      if (format === 'whatsapp') out.push(...fence, line)
      else if (format === 'html') out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`)
      else out.push(...fence)
      fence = undefined
      return
    }
    if (fence !== undefined) { fence.push(line); return }
    out.push(blockLine(line, format, !(i === 0 && opts.continuation)))
  })
  // An unclosed fence: keep its content as is.
  if (fence !== undefined) out.push(...(format === 'html' ? [escapeHtml(fence.join('\n'))] : fence))
  return out.join('\n')
}

/** True when an incomplete line fragment has no open inline marker (safe to convert now). */
function balanced(fragment: string): boolean {
  const count = (re: RegExp) => (fragment.match(re) ?? []).length
  return count(/\*\*/g) % 2 === 0 && count(/~~/g) % 2 === 0 && count(/__/g) % 2 === 0 && count(/`/g) % 2 === 0
    && count(/\[/g) === count(/\]/g) && count(/\(/g) === count(/\)/g)
}

/** Below this many buffered characters without a newline, wait for more text before cutting mid-line. */
const MIN_MIDLINE_CUT = 120

/**
 * Streaming twin of {@link formatMarkdown}: buffers just enough of the stream
 * to convert complete constructs (whole lines, or a long line up to a space
 * where no marker is open) and yields the converted pieces. `return()` stops
 * the source immediately (so `ctx.stream()` cancellation still aborts the
 * provider request).
 */
export function formatMarkdownStream(source: AsyncIterable<string>, format: TextFormat): AsyncIterableIterator<string> {
  const src = source[Symbol.asyncIterator]()
  if (format === 'markdown') {
    const passthrough: AsyncIterableIterator<string> = {
      next: () => src.next(),
      return: async (value?: unknown) => { await src.return?.(value); return { done: true, value: undefined } },
      [Symbol.asyncIterator]: () => passthrough,
    }
    return passthrough
  }
  let buffer = ''
  let atLineStart = true
  let finished = false
  let fenceOpen = false

  const take = (end: number): string => {
    const piece = buffer.slice(0, end)
    buffer = buffer.slice(end)
    const out = formatMarkdown(piece, format, { continuation: !atLineStart })
    atLineStart = piece.endsWith('\n')
    return out
  }

  /** The next convertible piece of the buffer, or undefined when more text is needed. */
  const cut = (): string | undefined => {
    let lastSafeNewline = -1
    let open = fenceOpen
    let lineStart = 0
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== '\n') continue
      const line = buffer.slice(lineStart, i)
      // A fence line toggles (the very first line may continue a previous piece: never a fence then).
      if (!(lineStart === 0 && !atLineStart) && FENCE_LINE.test(line)) open = !open
      lineStart = i + 1
      if (!open) lastSafeNewline = i
    }
    if (lastSafeNewline >= 0) {
      // Everything up to there is either outside a fence or a complete fenced block.
      fenceOpen = false
      return take(lastSafeNewline + 1)
    }
    if (fenceOpen || open) return undefined
    if (buffer.length < MIN_MIDLINE_CUT) return undefined
    for (let i = buffer.lastIndexOf(' '); i > 0; i = buffer.lastIndexOf(' ', i - 1)) {
      if (balanced(buffer.slice(0, i))) return take(i + 1)
    }
    return undefined
  }

  const it: AsyncIterableIterator<string> = {
    async next(): Promise<IteratorResult<string>> {
      while (!finished) {
        const piece = cut()
        if (piece) return { done: false, value: piece }
        const r = await src.next()
        if (finished) break
        if (r.done) {
          finished = true
          if (buffer) {
            const rest = formatMarkdown(buffer, format, { continuation: !atLineStart })
            buffer = ''
            if (rest) return { done: false, value: rest }
          }
          break
        }
        if (typeof r.value === 'string') buffer += r.value
      }
      return { done: true, value: undefined }
    },
    async return(value?: unknown): Promise<IteratorResult<string>> {
      finished = true
      buffer = ''
      // Do not wait for a pending next(): stop the source (and its provider request) now.
      await src.return?.(value)
      return { done: true, value: undefined }
    },
    async throw(error?: unknown): Promise<IteratorResult<string>> {
      finished = true
      if (src.throw) await src.throw(error)
      else await src.return?.()
      throw error
    },
    [Symbol.asyncIterator]: () => it,
  }
  return it
}
