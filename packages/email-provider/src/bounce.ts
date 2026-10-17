/**
 * Bounce (non-delivery report) detection. Standard DSNs (RFC 3464,
 * `multipart/report; report-type=delivery-status`) are parsed exactly; legacy
 * bounces from MAILER-DAEMON fall back to headers like `X-Failed-Recipients`
 * and a scan of the body for the original Message-ID.
 */

import { normalizeAddress } from './address.js'
import { parseHeaders, parsePart, partText, type MimePart, type ParsedEmail } from './mime.js'

export interface BounceRecipient {
  /** Normalized failed recipient address. */
  address: string
  /** DSN `Action` (`failed`, `delayed`, `delivered`, `relayed`, `expanded`). */
  action: string
  /** Enhanced status code, e.g. `5.1.1`. */
  status?: string
  /** Diagnostic text from the remote MTA (type prefix like `smtp;` removed). */
  diagnostic?: string
  /** `true` for a hard bounce (5.x.x or `failed`): retrying will not help. */
  permanent: boolean
}

export interface BounceInfo {
  recipients: BounceRecipient[]
  /** Message-ID (no brackets) of the email that bounced, when the report carries it. */
  originalMessageId?: string
}

function walk(part: MimePart, visit: (p: MimePart) => void): void {
  visit(part)
  for (const c of part.children) walk(c, visit)
}

function stripType(value: string | undefined): string | undefined {
  if (!value) return undefined
  const semi = value.indexOf(';')
  return (semi === -1 ? value : value.slice(semi + 1)).trim() || undefined
}

function first(map: Map<string, string[]>, name: string): string | undefined {
  return map.get(name)?.[0]
}

function parseDeliveryStatus(text: string): BounceRecipient[] {
  // Blocks separated by blank lines: the first describes the message, the rest one recipient each.
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).map((b) => parseHeaders(b))
  const out: BounceRecipient[] = []
  for (const block of blocks) {
    const recipient = stripType(first(block, 'final-recipient') ?? first(block, 'original-recipient'))
    if (!recipient) continue
    const action = (first(block, 'action') ?? 'failed').trim().toLowerCase()
    const status = first(block, 'status')?.trim().split(/\s/)[0]
    out.push({
      address: normalizeAddress(recipient),
      action,
      status,
      diagnostic: stripType(first(block, 'diagnostic-code')),
      permanent: action === 'failed' || (status?.startsWith('5') ?? false),
    })
  }
  return out
}

function idFromHeaders(map: Map<string, string[]>): string | undefined {
  const raw = first(map, 'message-id')
  return raw ? /<([^<>\s]+)>/.exec(raw)?.[1] ?? raw.trim() : undefined
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)$/i
const BOUNCE_SUBJECT = /(undeliver|undelivered|delivery (status notification|failure|has failed)|returned mail|failure notice|mail delivery failed|no se (ha )?pudo entregar|non remis|unzustellbar)/i

/** Return bounce details when `email` is a delivery failure report, else `undefined`. */
export function detectBounce(email: ParsedEmail): BounceInfo | undefined {
  const root = email.root
  const isReport = root.contentType === 'multipart/report'
    && (root.contentTypeParams['report-type'] ?? '').toLowerCase() === 'delivery-status'
  let recipients: BounceRecipient[] = []
  let originalMessageId: string | undefined
  if (isReport) {
    walk(root, (p) => {
      if (p.contentType === 'message/delivery-status' || p.contentType === 'message/global-delivery-status') {
        recipients.push(...parseDeliveryStatus(partText(p)))
      } else if (!originalMessageId && (p.contentType === 'text/rfc822-headers' || p.contentType === 'message/rfc822-headers')) {
        originalMessageId = idFromHeaders(parseHeaders(p.body))
      } else if (!originalMessageId && (p.contentType === 'message/rfc822' || p.contentType === 'message/global')) {
        originalMessageId = idFromHeaders(parsePart(p.body).headers)
      }
    })
    return { recipients, originalMessageId }
  }

  const fromLocal = email.from ? email.from.address.slice(0, email.from.address.lastIndexOf('@')) : ''
  const failed = email.header('x-failed-recipients')
  const heuristic = failed !== undefined || (BOUNCE_SENDER.test(fromLocal) && BOUNCE_SUBJECT.test(email.subject))
  if (!heuristic) return undefined
  recipients = (failed ?? '').split(',').map((a) => a.trim()).filter(Boolean)
    .map((address) => ({ address: normalizeAddress(address), action: 'failed', status: undefined, diagnostic: undefined, permanent: true }))
  walk(root, (p) => {
    if (originalMessageId) return
    if (p.contentType === 'message/rfc822') originalMessageId = idFromHeaders(parsePart(p.body).headers)
    else if (p.contentType.startsWith('text/')) {
      const m = /^\s*Message-ID:\s*<([^<>\s]+)>/im.exec(partText(p))
      if (m) originalMessageId = m[1]
    }
  })
  return { recipients, originalMessageId }
}
