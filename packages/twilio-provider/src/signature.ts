/**
 * X-Twilio-Signature verification (same algorithm as Twilio's own SDKs).
 *
 *  - Form webhooks (`application/x-www-form-urlencoded`): the signed string is
 *    the EXACT webhook URL followed by every POST parameter, sorted by name,
 *    appended as `name + value` (repeated names: unique values, sorted).
 *  - JSON webhooks: Twilio adds `bodySHA256=<hex sha256 of the raw body>` to
 *    the URL's query and signs the URL alone; the body hash is checked too.
 *  - Signature = base64(HMAC-SHA1(authToken, signedString)).
 *  - Like the SDKs, the URL is tried as-is, with its default port added and
 *    with it removed, because proxies disagree about `:443`.
 */

import { createHash, createHmac } from 'node:crypto'
import { safeEqual } from './http.js'

export type TwilioParams = Record<string, string | string[]>

/** Hex SHA-256 of a raw body, as Twilio puts it in `bodySHA256`. */
export function bodySha256(rawBody: string): string {
  return createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex')
}

/** Compute the expected signature for a URL + POST params. */
export function computeTwilioSignature(authToken: string, url: string, params: TwilioParams = {}): string {
  let data = url
  for (const name of Object.keys(params).sort()) {
    const value = params[name]
    if (Array.isArray(value)) {
      for (const item of [...new Set(value)].sort()) data += name + item
    } else {
      data += name + value
    }
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

/** URL variants Twilio may have signed: as given, with default port, without port. */
function urlVariants(url: string): string[] {
  const variants = [url]
  // Textual on purpose: `URL` silently drops a default port, hiding what was signed.
  const match = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(url)
  if (!match) return variants
  const [, scheme, authority, rest] = match as unknown as [string, string, string, string]
  const defaultPort = scheme.toLowerCase() === 'https' ? '443' : '80'
  const portMatch = /^(.*):(\d+)$/.exec(authority)
  if (!portMatch) variants.push(`${scheme}://${authority}:${defaultPort}${rest}`)
  else if (portMatch[2] === defaultPort) variants.push(`${scheme}://${portMatch[1]}${rest}`)
  return variants
}

export interface VerifyTwilioInput {
  authToken: string
  signature: string | undefined
  url: string
  /** Form params (form webhooks). Ignored when the URL carries `bodySHA256`. */
  params?: TwilioParams
  /**
   * Raw body of a JSON webhook. When set, the URL MUST carry `bodySHA256`
   * (otherwise verification fails: the body would be unauthenticated).
   */
  rawBody?: string
}

/** True when `signature` matches the URL + params (or URL + body hash) under `authToken`. */
export function verifyTwilioSignature(input: VerifyTwilioInput): boolean {
  const { authToken, signature, url } = input
  if (!signature || !authToken) return false
  let bodyHash: string | null = null
  try {
    bodyHash = new URL(url).searchParams.get('bodySHA256')
  } catch {
    return false
  }
  if (bodyHash !== null) {
    if (input.rawBody === undefined) return false
    const actual = bodySha256(input.rawBody)
    if (!safeEqual(actual, bodyHash.toLowerCase())) return false
    return urlVariants(url).some((candidate) => safeEqual(computeTwilioSignature(authToken, candidate, {}), signature))
  }
  // A raw (JSON) body is only authenticated through `bodySHA256`; a URL-only
  // signature would otherwise vouch for any body sent along with it.
  if (input.rawBody !== undefined) return false
  const params = input.params ?? {}
  return urlVariants(url).some((candidate) => safeEqual(computeTwilioSignature(authToken, candidate, params), signature))
}

/** Parse an `application/x-www-form-urlencoded` body into Twilio params (repeats → arrays). */
export function parseFormParams(raw: string): TwilioParams {
  const out: TwilioParams = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

/** Normalize an already-parsed body object (express `urlencoded`) into Twilio params. */
export function paramsFromObject(body: Record<string, unknown>): TwilioParams {
  const out: TwilioParams = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) out[key] = value.map((v) => String(v))
    else out[key] = String(value)
  }
  return out
}
