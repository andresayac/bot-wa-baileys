/**
 * Webhook verification for the Messenger API for Instagram.
 *
 * Identical handshake to every Meta Graph webhook platform (WhatsApp Cloud API,
 * Messenger, Instagram):
 *  1. `verifyChallenge` — the one-time GET handshake Meta does when you save a
 *     webhook subscription: it sends `hub.mode=subscribe`, `hub.verify_token`
 *     and `hub.challenge`; you must echo the challenge only if the token matches.
 *  2. `verifySignature` — every POST is signed by Meta as
 *     `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(rawBody, appSecret).
 *     Verify it (constant-time) to reject forged webhooks.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface ChallengeQuery {
  'hub.mode'?: string
  'hub.verify_token'?: string
  'hub.challenge'?: string
}

/**
 * Validate the webhook GET handshake. Returns the challenge string to echo back
 * (HTTP 200) when valid, or `null` when the token doesn't match (host → 403).
 */
export function verifyChallenge(query: ChallengeQuery, expectedVerifyToken: string): string | null {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expectedVerifyToken) {
    return query['hub.challenge'] ?? null
  }
  return null
}

/**
 * Verify a POST body against its `X-Hub-Signature-256` header using the app
 * secret. Constant-time. Returns false (reject) if the secret is unset, the
 * header is missing, or the digest doesn't match.
 */
export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false
  const expected = signatureHeader.replace(/^sha256=/, '')
  const digest = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody))
    .digest('hex')
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
