/**
 * Shared webhook-ingest guard for the Graph transports. Encapsulates the
 * (previously triplicated) appSecret check: raw-body handling, the
 * X-Hub-Signature-256 verification, and the "non-raw body while appSecret set"
 * footgun warning.
 */

import { verifySignature } from './webhook.js'

export interface GraphIngestLogger {
  warn?: (msg: string) => void
}

export type GraphSignatureResult =
  | { ok: true }
  | { ok: false; status: number }

/**
 * Verify an inbound webhook's signature when `appSecret` is configured.
 *
 * - No `appSecret` → `{ ok: true }` (the provider only permits this after an
 *   explicit local-development opt-out).
 * - `appSecret` set → checks `X-Hub-Signature-256` over the RAW request bytes.
 *   A non-raw (already-parsed) body is rejected because Meta signs the exact
 *   bytes it sent and re-serialization is not equivalent.
 */
export function checkGraphSignature(
  body: unknown,
  headers: Record<string, string | string[] | undefined> | undefined,
  appSecret: string | undefined,
  logger?: GraphIngestLogger,
): GraphSignatureResult {
  if (!appSecret) return { ok: true }
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    logger?.warn?.(
      'ingest received a non-raw body while appSecret is set — signature verification needs the raw ' +
        'request bytes (use express.raw()/the raw body string).',
    )
    return { ok: false, status: 400 }
  }
  const raw = body as string | Buffer
  const sig = headerValue(headers, 'x-hub-signature-256')
  const sigStr = Array.isArray(sig) ? sig[0] : sig
  if (!verifySignature(raw, sigStr, appSecret)) {
    logger?.warn?.('webhook rejected: invalid X-Hub-Signature-256')
    return { ok: false, status: 403 }
  }
  return { ok: true }
}

/** Case-insensitive header read (hosts may hand over `X-Hub-Signature-256` as sent). */
function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | string[] | undefined {
  if (!headers) return undefined
  if (headers[name] !== undefined) return headers[name]
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
  return undefined
}

/** Parse a webhook body (raw string, Buffer, or already-parsed object) into T. */
export function parseGraphBody<T>(body: unknown): T {
  if (typeof body === 'string') return JSON.parse(body) as T
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8')) as T
  return body as T
}
