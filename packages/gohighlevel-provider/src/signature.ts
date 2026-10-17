/**
 * HighLevel webhook authentication.
 *
 *  - `X-GHL-Signature`: base64 Ed25519 signature of the raw request body,
 *    verified with HighLevel's published public key (current scheme).
 *  - `X-WH-Signature`: base64 RSA-SHA256 signature of the raw body (legacy,
 *    retired 2026-09-01) — verified only when a legacy key is configured.
 *
 * Signatures are computed over the RAW bytes, never re-serialized JSON.
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto'

/** HighLevel's Ed25519 webhook public key (marketplace.gohighlevel.com, Webhook Integration Guide). */
export const GHL_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`

export type GhlSignatureResult = { ok: true; scheme: 'ed25519' | 'rsa' } | { ok: false; reason: string }

export interface VerifyGhlInput {
  rawBody: Buffer
  ghlSignature?: string
  legacySignature?: string
  publicKey?: string | KeyObject
  legacyPublicKey?: string | KeyObject
}

function toKey(key: string | KeyObject): KeyObject {
  return typeof key === 'string' ? createPublicKey(key) : key
}

function decode(signature: string): Buffer | undefined {
  const trimmed = signature.trim()
  if (!trimmed || trimmed === 'N/A' || !/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) return undefined
  return Buffer.from(trimmed, 'base64')
}

export function verifyGhlSignature(input: VerifyGhlInput): GhlSignatureResult {
  try {
    if (input.ghlSignature !== undefined) {
      const sig = decode(input.ghlSignature)
      if (!sig) return { ok: false, reason: 'malformed X-GHL-Signature' }
      const key = toKey(input.publicKey ?? GHL_WEBHOOK_PUBLIC_KEY)
      return verify(null, input.rawBody, key, sig) ? { ok: true, scheme: 'ed25519' } : { ok: false, reason: 'invalid X-GHL-Signature' }
    }
    if (input.legacySignature !== undefined && input.legacyPublicKey) {
      const sig = decode(input.legacySignature)
      if (!sig) return { ok: false, reason: 'malformed X-WH-Signature' }
      const key = toKey(input.legacyPublicKey)
      return verify('sha256', input.rawBody, key, sig) ? { ok: true, scheme: 'rsa' } : { ok: false, reason: 'invalid X-WH-Signature' }
    }
    return { ok: false, reason: 'missing X-GHL-Signature' }
  } catch {
    return { ok: false, reason: 'signature verification error' }
  }
}
