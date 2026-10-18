/**
 * Opt-in sender authentication via `Authentication-Results` (RFC 8601).
 *
 * `From` is not authenticated by email itself: anyone can send mail claiming to
 * be anyone. The receiving MTA usually checks SPF/DKIM/DMARC and stamps the
 * verdict in an `Authentication-Results` header. Only headers whose authserv-id
 * is the operator's own MTA count, because a sender can add any number of
 * forged ones before the message reaches it.
 */

import { domainOf } from './address.js'
import type { ParsedEmail } from './mime.js'

function stripComments(value: string): string {
  let out = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (quoted) {
      out += ch
      if (ch === '\\' && i + 1 < value.length) out += value[++i]
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"' && depth === 0) { quoted = true; out += ch; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')' && depth > 0) { depth--; continue }
    if (depth === 0) out += ch
  }
  return out
}

interface ResInfo {
  method: string
  result: string
  props: Map<string, string>
}

function parseResults(value: string): { authservId: string; results: ResInfo[] } | undefined {
  const parts = stripComments(value).split(';').map((p) => p.trim())
  const authservId = (parts.shift() ?? '').split(/\s+/)[0]?.toLowerCase()
  if (!authservId) return undefined
  const results: ResInfo[] = []
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean)
    const head = tokens.shift()
    const eq = head?.indexOf('=') ?? -1
    if (!head || eq <= 0) continue
    const props = new Map<string, string>()
    for (const t of tokens) {
      const i = t.indexOf('=')
      if (i > 0) props.set(t.slice(0, i).toLowerCase(), t.slice(i + 1).replace(/^"|"$/g, '').toLowerCase())
    }
    results.push({ method: head.slice(0, eq).toLowerCase().split('/')[0]!, result: head.slice(eq + 1).toLowerCase(), props })
  }
  return { authservId, results }
}

/** Relaxed DMARC alignment: same domain or one is a subdomain of the other. */
function aligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/**
 * True when the MTA identified by `authservId` recorded `dmarc=pass`, or
 * `dkim=pass` with a signing domain aligned to the From domain.
 */
export function isAuthenticated(email: ParsedEmail, authservId: string): boolean {
  const fromDomain = email.from ? domainOf(email.from.address) : undefined
  if (!fromDomain) return false
  const trusted = authservId.trim().toLowerCase()
  for (const value of email.headers.get('authentication-results') ?? []) {
    const parsed = parseResults(value)
    if (!parsed || parsed.authservId !== trusted) continue
    for (const r of parsed.results) {
      if (r.result !== 'pass') continue
      if (r.method === 'dmarc') {
        const hf = r.props.get('header.from')
        if (!hf || aligned(hf, fromDomain)) return true
      }
      if (r.method === 'dkim') {
        const d = r.props.get('header.d') ?? domainOf(r.props.get('header.i') ?? '')
        if (d && aligned(d, fromDomain)) return true
      }
    }
  }
  return false
}
