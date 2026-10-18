/**
 * RFC 5322 address-list parsing and canonical address normalization.
 *
 * The provider's identity contract (one human -> one `senderId`) is enforced by
 * `normalizeAddress`: every inbound sender and every outbound recipient goes
 * through the same function, so `Ana@Example.COM` and `ana@example.com` are
 * the same sender.
 */

import { decodeEncodedWords } from './mime-words.js'

export interface EmailAddress {
  /** Display name, RFC 2047-decoded. */
  name?: string
  /** The address as written (not normalized). */
  address: string
}

/** Canonical form of an address: trimmed, angle brackets removed, lower-cased. */
export function normalizeAddress(address: string): string {
  return address.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase()
}

/** Split on `sep` outside quotes, angle brackets and comments. */
function splitTopLevel(input: string, seps: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angle = 0
  let comment = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quoted) {
      cur += ch
      if (ch === '\\' && i + 1 < input.length) { cur += input[++i]; continue }
      if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '<') angle++
    else if (ch === '>' && angle > 0) angle--
    else if (ch === '(') comment++
    else if (ch === ')' && comment > 0) comment--
    else if (angle === 0 && comment === 0 && seps.includes(ch)) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1')
  return t
}

function parseMailbox(token: string): EmailAddress | undefined {
  const t = token.trim()
  if (!t) return undefined
  const lt = t.lastIndexOf('<')
  const gt = t.lastIndexOf('>')
  if (lt !== -1 && gt > lt) {
    const address = t.slice(lt + 1, gt).trim()
    if (!address.includes('@')) return undefined
    const rawName = t.slice(0, lt).replace(/\([^)]*\)/g, '').trim()
    const name = rawName ? decodeEncodedWords(unquote(rawName)).trim() : ''
    return { name: name || undefined, address }
  }
  const bare = t.replace(/\([^)]*\)/g, '').trim()
  if (!bare.includes('@') || /\s/.test(bare)) return undefined
  return { name: undefined, address: bare }
}

/**
 * Parse an address-list header value (`From`, `To`, `Cc`, `Reply-To`). Group
 * syntax (`Team: a@x, b@x;`) is flattened; entries without an `@` are dropped.
 */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return []
  const out: EmailAddress[] = []
  // Flatten group syntax: "Team: a, b;" -> "a, b". A ':' outside quotes/brackets
  // ends the group name, a ';' closes the group.
  for (const token of splitTopLevel(value, ',')) {
    for (const piece of splitTopLevel(token, ';')) {
      const parts = splitTopLevel(piece, ':')
      const mailbox = parseMailbox(parts[parts.length - 1]!)
      if (mailbox) out.push(mailbox)
    }
  }
  return out
}

/** The domain part of an address (lower-cased), or `undefined`. */
export function domainOf(address: string): string | undefined {
  const at = address.lastIndexOf('@')
  if (at === -1) return undefined
  return normalizeAddress(address.slice(at + 1)) || undefined
}

/** True when the string is a plausible single address (used to accept address chatIds). */
export function looksLikeAddress(value: string): boolean {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(value.trim())
}
