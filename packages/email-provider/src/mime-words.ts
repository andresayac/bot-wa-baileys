/**
 * Low-level MIME decoders: charsets, quoted-printable and RFC 2047 encoded
 * words. Kept apart from `mime.ts` so `address.ts` can use them without a cycle.
 */

const CHARSET_ALIASES: Record<string, string> = {
  'utf8': 'utf-8',
  'latin1': 'iso-8859-1',
  'ascii': 'us-ascii',
  'us-ascii': 'utf-8', // a superset decode is harmless and tolerates 8-bit leaks
  'ks_c_5601-1987': 'euc-kr',
}

/** Decode bytes in `charset`, falling back to UTF-8 and then latin1 on unknown labels. */
export function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  const resolved = CHARSET_ALIASES[label] ?? label
  try {
    return new TextDecoder(resolved).decode(bytes)
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return bytes.toString('latin1')
    }
  }
}

/** Decode quoted-printable text (body form: `=XX` escapes and soft line breaks). */
export function decodeQuotedPrintable(input: Buffer | string): Buffer {
  const s = (typeof input === 'string' ? input : input.toString('latin1')).replace(/=[ \t]*\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    if (ch === 0x3d /* = */ && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      out.push(ch & 0xff)
    }
  }
  return Buffer.from(out)
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g

function decodeWord(charset: string, encoding: string, text: string): string | undefined {
  const cs = charset.split('*')[0]! // RFC 2231 language suffix: charset*lang
  if (encoding.toUpperCase() === 'B') {
    if (!/^[A-Za-z0-9+/=]*$/.test(text)) return undefined
    return decodeCharset(Buffer.from(text, 'base64'), cs)
  }
  return decodeCharset(decodeQuotedPrintable(text.replace(/_/g, ' ')), cs)
}

/**
 * Decode RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`).
 * Whitespace between two adjacent encoded words is dropped, as the RFC requires.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    try {
      return decodeWord(charset, encoding, text) ?? whole
    } catch {
      return whole
    }
  })
}
