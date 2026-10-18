/**
 * HTML -> plain text for inbound emails that ship only an HTML body. Not a
 * renderer: it keeps the readable structure (paragraphs, line breaks, list
 * items, link targets) and drops everything a bot cannot use.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  euro: '€', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  ccedil: 'ç', Ccedil: 'Ç', agrave: 'à', egrave: 'è', ograve: 'ò', ouml: 'ö', auml: 'ä', szlig: 'ß',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', deg: '°', ordm: 'º', ordf: 'ª',
  zwnj: '', zwj: '', shy: '',
}

/** Decode HTML character references (named subset + all numeric forms). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[ref] ?? NAMED_ENTITIES[ref.toLowerCase()] ?? whole
  })
}

const BLOCK_END = /<\/(p|div|tr|h[1-6]|li|blockquote|table|ul|ol|section|article|header|footer|pre)\s*>/gi
const BLOCK_START = /<(p|div|tr|h[1-6]|blockquote|table|ul|ol|section|article|header|footer|pre)(\s[^>]*)?>/gi

/** Convert an HTML email body to readable plain text. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' ') // source newlines are insignificant whitespace in HTML
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_whole, _q, d1?: string, d2?: string, d3?: string, inner?: string) => {
      const href = decodeEntities((d1 ?? d2 ?? d3 ?? '').trim())
      const label = (inner ?? '').replace(/<[^>]*>/g, '')
      const labelText = decodeEntities(label).trim()
      if (!href || /^(mailto:|#|javascript:)/i.test(href) || href === labelText || !/^https?:/i.test(href)) return label
      return `${label} (${href})`
    })
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(BLOCK_START, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  const lines = s.split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim())
  // Paragraph tags produce single breaks; explicit <br><br> runs keep ONE blank line.
  const out: string[] = []
  let blank = 0
  for (const line of lines) {
    if (line === '') { blank++; continue }
    if (out.length && blank >= 3) out.push('')
    out.push(line)
    blank = 0
  }
  return out.join('\n').trim()
}
