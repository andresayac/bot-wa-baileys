/**
 * TikTok webhook signature verification (TikTok API for Business,
 * "Webhook verification"):
 *
 *   TikTok-Signature: t=<unix seconds>,s=<hex>
 *   s = hex(HMAC-SHA256(key = app secret, msg = `${t}.${rawBody}`))
 *
 * The timestamp is part of the signed payload, so a replayed request can only
 * be detected by bounding its age — `toleranceSec` (default 300 s).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface ParsedSignatureHeader {
  timestamp: number
  signatures: string[]
}

/** Split `t=..,s=..` into its parts. `undefined` when the header is unusable. */
export function parseSignatureHeader(header: string | undefined): ParsedSignatureHeader | undefined {
  if (!header) return undefined
  let timestamp: number | undefined
  const signatures: string[] = []
  for (const element of header.split(',')) {
    const eq = element.indexOf('=')
    if (eq < 0) continue
    const key = element.slice(0, eq).trim()
    const value = element.slice(eq + 1).trim()
    if (key === 't') {
      if (!/^\d+$/.test(value)) return undefined
      timestamp = Number(value)
    } else if (key === 's' && value) {
      signatures.push(value)
    }
  }
  if (timestamp === undefined || signatures.length === 0) return undefined
  return { timestamp, signatures }
}

export interface VerifySignatureOptions {
  /** Max |now - t| in seconds. Default 300. */
  toleranceSec?: number
  /** Current unix time in seconds (tests). Default `Date.now() / 1000`. */
  nowSec?: number
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'mismatch' | 'stale' }

/**
 * Verify a webhook body against its `TikTok-Signature` header. Constant-time
 * comparison; the signature is checked BEFORE the timestamp window so a
 * tampered `t` reports `mismatch`.
 */
export function verifyTikTokSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
  options: VerifySignatureOptions = {},
): SignatureCheck {
  const parsed = parseSignatureHeader(header)
  if (!parsed) return { ok: false, reason: 'missing' }
  const digest = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.`)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest()
  const matches = parsed.signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false
    const candidate = Buffer.from(sig, 'hex')
    return candidate.length === digest.length && timingSafeEqual(candidate, digest)
  })
  if (!matches) return { ok: false, reason: 'mismatch' }
  const tolerance = options.toleranceSec ?? 300
  const now = options.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'stale' }
  return { ok: true }
}
