/**
 * Webhook authentication for Chatwoot → bot callbacks.
 *
 * Two mechanisms, either is enough (configure at least one):
 *  - **Shared token** (`webhookToken`): add it to the webhook URL you register in
 *    Chatwoot (`https://bot.example.com/chatwoot?token=…`), or send it as
 *    `x-chatwoot-token: …` / `Authorization: Bearer …`.
 *  - **HMAC-SHA256** (`webhookSecret`): hex signature in `x-chatwoot-signature`
 *    (optionally `sha256=`-prefixed) computed over the RAW request body — or over
 *    `${timestamp}.${rawBody}` when an `x-chatwoot-timestamp` header (seconds) is sent,
 *    in which case the timestamp must be within the tolerance window.
 *
 * Comparisons are constant-time. The signature is always computed on the raw bytes,
 * never on re-serialized JSON.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type HeaderBag = Record<string, string | string[] | undefined> | Headers

export interface WebhookAuthConfig {
  token?: string
  secret?: string
  /** Max clock skew for timestamped signatures, in seconds. Default 300. */
  toleranceSec?: number
  now: () => number
}

export function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const bag = headers as Record<string, string | string[] | undefined>
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name)
  const v = key === undefined ? undefined : bag[key]
  return Array.isArray(v) ? v[0] : v
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab) // keep timing roughly constant
    return false
  }
  return timingSafeEqual(ab, bb)
}

function tokenOk(expected: string, headers: HeaderBag, queryToken: string | undefined): boolean {
  const auth = header(headers, 'authorization')
  const bearer = auth && /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]
  const candidates = [queryToken, header(headers, 'x-chatwoot-token'), bearer ?? undefined]
  return candidates.some((c) => typeof c === 'string' && c !== '' && safeEqual(c, expected))
}

function signatureOk(cfg: WebhookAuthConfig, secret: string, rawBody: Buffer, headers: HeaderBag): boolean {
  const provided = header(headers, 'x-chatwoot-signature')?.trim().replace(/^sha256=/i, '').toLowerCase()
  if (!provided || !/^[0-9a-f]{64}$/.test(provided)) return false
  const ts = header(headers, 'x-chatwoot-timestamp')?.trim()
  const digest = (parts: Array<string | Buffer>) => {
    const h = createHmac('sha256', secret)
    for (const p of parts) h.update(p)
    return h.digest('hex')
  }
  if (ts !== undefined && ts !== '') {
    const sec = Number(ts)
    if (!Number.isFinite(sec)) return false
    if (Math.abs(cfg.now() / 1000 - sec) > (cfg.toleranceSec ?? 300)) return false
    if (safeEqual(provided, digest([`${ts}.`, rawBody]))) return true
  }
  return safeEqual(provided, digest([rawBody]))
}

/** True when the request carries a valid token or signature. */
export function verifyWebhook(cfg: WebhookAuthConfig, rawBody: Buffer, headers: HeaderBag, queryToken: string | undefined): boolean {
  if (cfg.token !== undefined && tokenOk(cfg.token, headers, queryToken)) return true
  if (cfg.secret !== undefined && signatureOk(cfg, cfg.secret, rawBody, headers)) return true
  return cfg.token === undefined && cfg.secret === undefined
}
